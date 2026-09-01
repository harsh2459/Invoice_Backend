/**
 * File-type detection from filename — ported verbatim from Drogon
 * `parsers/detector.py`. Given a filename, decides which platform/parser handles
 * it. The non-existent `tally_xml` parser is dropped (those files -> skipped).
 */
import crypto from "crypto";

export interface Detection {
  platform: "amazon" | "flipkart" | "meesho" | "bank" | "purchase" | "unknown";
  parser: string | null;
  ext: string;
  bank_name?: string;
  account_number?: string | null;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// (keyword_in_filename, parser_key, display_bank_name) — order matters
const BANK_PATTERNS: [string, string, string][] = [
  ["hdfc", "hdfc_bank_pdf", "HDFC BANK"],
  ["baroda", "bob_bank_pdf", "BANK OF BARODA"],
  ["canara", "canara_bank_pdf", "CANARA BANK"],
  ["yes", "yes_bank_pdf", "YES BANK"],
  ["sbi", "sbi_bank_pdf", "STATE BANK OF INDIA"],
  ["axis", "axis_bank_pdf", "AXIS BANK"],
  ["icici", "icici_bank_pdf", "ICICI BANK"],
  ["kotak", "kotak_bank_pdf", "KOTAK BANK"],
  ["pnb", "pnb_bank_pdf", "PUNJAB NATIONAL BANK"],
  ["union", "union_bank_pdf", "UNION BANK"],
];
const BANK_XML_PATTERNS: [string, string, string][] = BANK_PATTERNS.map(
  ([kw, parser, name]) => [kw, parser.replace("_pdf", "_xml"), name]
);

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}
function extOf(name: string): string {
  const m = name.match(/(\.[^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}

/** Pull an account-number-ish digit run out of a filename. */
function extractAccountFromFilename(name: string): string | null {
  const cleaned = name.replace(/[_-]/g, " ");
  const groups = cleaned.match(/\b\d[\d\s]{2,}\d\b/g);
  if (groups && groups.length) {
    return groups.reduce((a, b) => (b.length > a.length ? b : a)).trim();
  }
  const short = cleaned.match(/\b\d{4,}\b/);
  return short ? short[0] : null;
}

export function detectPlatform(filename: string): Detection {
  const name = baseName(filename).toLowerCase();
  const ext = extOf(name);
  const basenameNoExt = baseName(filename).replace(/\.[^.]+$/, "");

  if (ext === ".pdf") {
    if (name.includes("bank")) {
      for (const [kw, parser, display] of BANK_PATTERNS) {
        if (name.includes(kw)) {
          return {
            platform: "bank",
            parser,
            ext: "pdf",
            bank_name: display,
            account_number: extractAccountFromFilename(name),
          };
        }
      }
      return {
        platform: "bank",
        parser: "generic_bank_pdf",
        ext: "pdf",
        bank_name: "BANK",
        account_number: extractAccountFromFilename(name),
      };
    }
    // ADS-XXXX / KA-XXXX / KA-C-XXXX and any other pdf -> purchase invoice
    return { platform: "purchase", parser: "amazon_purchase_pdf", ext: "pdf" };
  }

  if (ext === ".xml") {
    if (name.includes("tally")) {
      return { platform: "unknown", parser: null, ext: "xml" }; // no tally_xml parser
    }
    if (name.includes("bank")) {
      for (const [kw, parser, display] of BANK_XML_PATTERNS) {
        if (name.includes(kw)) {
          return {
            platform: "bank",
            parser,
            ext: "xml",
            bank_name: display,
            account_number: extractAccountFromFilename(name),
          };
        }
      }
      return {
        platform: "bank",
        parser: "generic_bank_xml",
        ext: "xml",
        bank_name: "BANK",
        account_number: extractAccountFromFilename(name),
      };
    }
    return { platform: "unknown", parser: null, ext: "xml" };
  }

  if (ext === ".csv") {
    if (name.includes("mtr_b2b") || (name.includes("mtr") && name.includes("b2b")))
      return { platform: "amazon", parser: "amazon_b2b_csv", ext: "csv" };
    if (name.includes("mtr_b2c") || (name.includes("mtr") && name.includes("b2c")))
      return { platform: "amazon", parser: "amazon_b2c_csv", ext: "csv" };
    if (name.includes("mtr")) return { platform: "amazon", parser: "amazon_b2c_csv", ext: "csv" };
    if (name.startsWith("orders_") && name.endsWith(".csv"))
      return { platform: "meesho", parser: "meesho_orders_csv", ext: "csv" };
    return { platform: "unknown", parser: null, ext: "csv" };
  }

  if (ext === ".xlsx" || ext === ".xls") {
    if (name.includes("tcs_sales_return"))
      return { platform: "meesho", parser: "meesho_returns", ext: "xlsx" };
    if (name.includes("tcs_sales"))
      return { platform: "meesho", parser: "meesho_sales", ext: "xlsx" };
    if (name.includes("tax_invoice"))
      return { platform: "meesho", parser: "meesho_invoices", ext: "xlsx" };
    if (name.includes("flipkart") || basenameNoExt.length > 20)
      return { platform: "flipkart", parser: "flipkart_xlsx", ext: "xlsx" };
    return { platform: "unknown", parser: null, ext: "xlsx" };
  }

  return { platform: "unknown", parser: null, ext: ext.replace(/^\./, "") };
}
