/**
 * Import orchestration — port of Drogon `routes/imports.py` `_run_parsers` +
 * `import_file` / `upload_and_import`. Upload-only (no NAS).
 *
 * Flow: sha256(bytes) -> dedup vs col_import_logs.checksum -> detectPlatform ->
 * parse -> bulk insert tagged with company_id + source_file + period -> log.
 * Bank imports (Phase D) will additionally run the ledger rule engine.
 */
import { exec, query } from "../db";
import { detectPlatform, sha256 } from "./parsers/detector";
import { parseAmazonCsv } from "./parsers/amazonParser";
import { parseFlipkartXlsx } from "./parsers/flipkartParser";
import {
  parseMeeshoSales,
  parseMeeshoReturns,
  parseMeeshoInvoices,
  loadOrdersSkuMap,
} from "./parsers/meeshoParser";
import { parseFeeInvoicePdf } from "./parsers/feeInvoiceParser";
import { parseBankFile } from "./parsers/bankParser";
import { applyLedgerRules } from "./ledgerEngine";

export interface ImportInput {
  buffer: Buffer;
  filename: string;
  companyId: number | null;
  dataMonth: number | null;
  dataYear: number | null;
}

export interface ImportResult {
  status: "success" | "skipped" | "failed";
  message?: string;
  rows_imported?: number;
  platform?: string;
  log_id?: number;
  error?: string;
}

/** Which tables a platform's data lives in (for delete-with-data). */
export const PLATFORM_TABLES: Record<string, string[]> = {
  amazon: ["col_amazon_mtr"],
  flipkart: ["col_flipkart_sales", "col_flipkart_cashback"],
  meesho: ["col_meesho_sales", "col_meesho_returns", "col_meesho_invoices"],
  bank: ["col_bank_txns"],
  purchase: ["col_fee_invoices"],
};

/** Bulk INSERT plain objects into `table`. Columns come from the first row's keys. */
async function bulkInsert(table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = Object.keys(rows[0]);
  const placeholders = `(${cols.map(() => "?").join(", ")})`;
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const sql = `INSERT INTO ${table} (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES ${slice
      .map(() => placeholders)
      .join(", ")}`;
    const params: unknown[] = [];
    for (const r of slice) for (const c of cols) params.push(r[c] ?? null);
    const res = (await exec(sql, params as any[]));
    inserted += res.affectedRows;
  }
  return inserted;
}

/** Tag every row with company_id + source_file + period (period only where the table has it). */
function tag(
  rows: Record<string, unknown>[],
  companyId: number | null,
  sourceFile: string,
  dataMonth: number | null,
  dataYear: number | null,
  withPeriod: boolean
) {
  for (const r of rows) {
    r.company_id = companyId;
    r.source_file = sourceFile;
    if (withPeriod) {
      r.data_month = dataMonth;
      r.data_year = dataYear;
    }
  }
}

export async function runImport(input: ImportInput): Promise<ImportResult> {
  const { buffer, filename, companyId, dataMonth, dataYear } = input;
  const checksum = sha256(buffer);

  const dup = await query<{ id: number }>(
    "SELECT id FROM col_import_logs WHERE checksum = ? LIMIT 1",
    [checksum]
  );
  if (dup[0]) {
    return { status: "skipped", message: "File already imported", log_id: dup[0].id };
  }

  const det = detectPlatform(filename);
  const sourceFile = `upload::${filename}`;

  const logRes = (await exec(
    `INSERT INTO col_import_logs
       (file_path, file_name, file_type, platform, checksum, file_size, status, company_id, data_month, data_year)
     VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
    [
      sourceFile,
      filename,
      det.ext,
      det.platform,
      checksum,
      buffer.length,
      companyId,
      dataMonth,
      dataYear,
    ]
  ));
  const logId = logRes.insertId;

  const fail = async (msg: string): Promise<ImportResult> => {
    await exec("UPDATE col_import_logs SET status = 'failed', error_message = ? WHERE id = ?", [
      msg.slice(0, 2000),
      logId,
    ]);
    return { status: "failed", error: msg, log_id: logId };
  };
  const skip = async (msg: string): Promise<ImportResult> => {
    await exec("UPDATE col_import_logs SET status = 'skipped', error_message = ? WHERE id = ?", [
      msg,
      logId,
    ]);
    return { status: "skipped", message: msg, log_id: logId };
  };
  const ok = async (rows: number): Promise<ImportResult> => {
    await exec("UPDATE col_import_logs SET status = 'success', rows_imported = ? WHERE id = ?", [
      rows,
      logId,
    ]);
    return { status: "success", rows_imported: rows, platform: det.platform, log_id: logId };
  };

  try {
    switch (det.parser) {
      case "amazon_b2c_csv":
      case "amazon_b2b_csv": {
        const rows = parseAmazonCsv(buffer, det.parser === "amazon_b2b_csv" ? "B2B" : "B2C");
        tag(rows, companyId, sourceFile, dataMonth, dataYear, true);
        return ok(await bulkInsert("col_amazon_mtr", rows));
      }

      case "flipkart_xlsx": {
        const { sales, cashbacks } = parseFlipkartXlsx(buffer);
        tag(sales, companyId, sourceFile, dataMonth, dataYear, true);
        tag(cashbacks, companyId, sourceFile, dataMonth, dataYear, true);
        const n =
          (await bulkInsert("col_flipkart_sales", sales)) +
          (await bulkInsert("col_flipkart_cashback", cashbacks));
        return ok(n);
      }

      case "meesho_orders_csv": {
        // Companion file — backfill SKU/product_name onto existing rows.
        const map = loadOrdersSkuMap(buffer);
        let updated = 0;
        for (const [sub, info] of map) {
          if (!info.sku) continue;
          const r1 = (await exec(
            "UPDATE col_meesho_sales SET sku = ?, product_name = ? WHERE sub_order_num = ?",
            [info.sku, info.product_name, sub]
          ));
          const r2 = (await exec(
            "UPDATE col_meesho_returns SET sku = ?, product_name = ? WHERE sub_order_num = ?",
            [info.sku, info.product_name, sub]
          ));
          updated += r1.affectedRows + r2.affectedRows;
        }
        return ok(updated);
      }

      case "meesho_sales": {
        const rows = parseMeeshoSales(buffer);
        tag(rows, companyId, sourceFile, dataMonth, dataYear, false); // meesho has no data_*
        return ok(await bulkInsert("col_meesho_sales", rows));
      }
      case "meesho_returns": {
        const rows = parseMeeshoReturns(buffer);
        tag(rows, companyId, sourceFile, dataMonth, dataYear, false);
        return ok(await bulkInsert("col_meesho_returns", rows));
      }
      case "meesho_invoices": {
        const rows = parseMeeshoInvoices(buffer);
        tag(rows, companyId, sourceFile, dataMonth, dataYear, false);
        return ok(await bulkInsert("col_meesho_invoices", rows));
      }

      case "amazon_purchase_pdf": {
        const rows = await parseFeeInvoicePdf(buffer);
        tag(rows, companyId, sourceFile, dataMonth, dataYear, true);
        return ok(await bulkInsert("col_fee_invoices", rows));
      }

      default: {
        // Bank statements — any *_bank_pdf / *_bank_xml / generic_bank_* parser key.
        if (det.parser && /_bank_(pdf|xml)$/.test(det.parser)) {
          const rows = await parseBankFile(buffer, {
            ext: det.ext,
            bankName: det.bank_name || "BANK",
            accountNumber: det.account_number ?? null,
          });
          tag(rows, companyId, sourceFile, dataMonth, dataYear, true);
          const n = await bulkInsert("col_bank_txns", rows);
          // auto-classify the freshly imported transactions
          await applyLedgerRules();
          return ok(n);
        }
        return skip(
          det.parser
            ? `Parser "${det.parser}" is not available yet (later phase).`
            : `Could not recognise this file (${det.ext || "no extension"}).`
        );
      }
        return skip(
          det.parser
            ? `Parser "${det.parser}" is not available yet (later phase).`
            : `Could not recognise this file (${det.ext || "no extension"}).`
        );
    }
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
}

/** Delete every data row that came from an import log's file. */
export async function deleteImportData(
  platform: string,
  filePath: string
): Promise<number> {
  let deleted = 0;
  for (const table of PLATFORM_TABLES[platform] || []) {
    const res = (await exec(`DELETE FROM ${table} WHERE source_file = ?`, [filePath]));
    deleted += res.affectedRows;
  }
  return deleted;
}
