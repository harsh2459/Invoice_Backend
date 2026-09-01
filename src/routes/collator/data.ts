/**
 * Collator data browsers — port of Drogon `routes/data.py` (Amazon/Flipkart/
 * Meesho only for Phase A; bank + delete land later). Paginated + filtered +
 * a `totals` summary computed over the whole filtered set.
 */
import { Router } from "express";
import { query } from "../../db";

const router = Router();

const like = (s: string) => `%${s}%`;

// ---- Amazon ----

router.get("/amazon", async (req, res, next) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const clauses: string[] = ["1=1"];
    const params: any[] = [];

    if (req.query.order_type) {
      clauses.push("order_type = ?");
      params.push(String(req.query.order_type));
    }
    if (req.query.transaction_type) {
      clauses.push("transaction_type LIKE ?");
      params.push(like(String(req.query.transaction_type)));
    }
    if (req.query.company_id) {
      clauses.push("company_id = ?");
      params.push(Number(req.query.company_id));
    }
    if (req.query.year) {
      clauses.push("data_year = ?");
      params.push(Number(req.query.year));
    }
    if (req.query.month) {
      clauses.push("data_month = ?");
      params.push(Number(req.query.month));
    }
    if (req.query.search) {
      const s = like(String(req.query.search));
      clauses.push("(order_id LIKE ? OR sku LIKE ? OR asin LIKE ? OR invoice_number LIKE ?)");
      params.push(s, s, s, s);
    }
    const where = clauses.join(" AND ");

    const totalRow = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM col_amazon_mtr WHERE ${where}`,
      params
    );
    const totals = await query<any>(
      `SELECT COALESCE(SUM(invoice_amount),0) AS invoice_amount,
              COALESCE(SUM(total_tax_amount),0) AS total_tax_amount,
              COALESCE(SUM(quantity),0) AS quantity
       FROM col_amazon_mtr WHERE ${where}`,
      params
    );
    const rows = await query(
      `SELECT * FROM col_amazon_mtr WHERE ${where} ORDER BY order_date DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, skip]
    );

    res.json({
      total: Number(totalRow[0]?.n || 0),
      rows,
      totals: {
        invoice_amount: Number(totals[0]?.invoice_amount || 0),
        total_tax_amount: Number(totals[0]?.total_tax_amount || 0),
        quantity: Number(totals[0]?.quantity || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---- Flipkart ----

router.get("/flipkart", async (req, res, next) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    if (req.query.company_id) {
      clauses.push("company_id = ?");
      params.push(Number(req.query.company_id));
    }
    if (req.query.year) {
      clauses.push("data_year = ?");
      params.push(Number(req.query.year));
    }
    if (req.query.month) {
      clauses.push("data_month = ?");
      params.push(Number(req.query.month));
    }
    if (req.query.search) {
      const s = like(String(req.query.search));
      clauses.push("(order_id LIKE ? OR sku LIKE ? OR fsn LIKE ?)");
      params.push(s, s, s);
    }
    const where = clauses.join(" AND ");

    const totalRow = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM col_flipkart_sales WHERE ${where}`,
      params
    );
    const totals = await query<any>(
      `SELECT COALESCE(SUM(invoice_amount),0) AS invoice_amount,
              COALESCE(SUM(taxable_value),0) AS taxable_value,
              COALESCE(SUM(igst_amount),0) AS igst_amount,
              COALESCE(SUM(tcs_amount),0) AS tcs_amount,
              COALESCE(SUM(quantity),0) AS quantity
       FROM col_flipkart_sales WHERE ${where}`,
      params
    );
    const rows = await query(
      `SELECT * FROM col_flipkart_sales WHERE ${where} ORDER BY order_date DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, skip]
    );

    res.json({
      total: Number(totalRow[0]?.n || 0),
      rows,
      totals: {
        invoice_amount: Number(totals[0]?.invoice_amount || 0),
        taxable_value: Number(totals[0]?.taxable_value || 0),
        igst_amount: Number(totals[0]?.igst_amount || 0),
        tcs_amount: Number(totals[0]?.tcs_amount || 0),
        quantity: Number(totals[0]?.quantity || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---- Meesho (period = financial_year + month_number) ----

router.get("/meesho", async (req, res, next) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    if (req.query.company_id) {
      clauses.push("company_id = ?");
      params.push(Number(req.query.company_id));
    }
    if (req.query.year) {
      clauses.push("financial_year = ?");
      params.push(Number(req.query.year));
    }
    if (req.query.month) {
      clauses.push("month_number = ?");
      params.push(Number(req.query.month));
    }
    if (req.query.search) {
      const s = like(String(req.query.search));
      clauses.push("(sub_order_num LIKE ? OR identifier LIKE ? OR sku LIKE ?)");
      params.push(s, s, s);
    }
    const where = clauses.join(" AND ");

    const totalRow = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM col_meesho_sales WHERE ${where}`,
      params
    );
    const totals = await query<any>(
      `SELECT COALESCE(SUM(total_invoice_value),0) AS total_invoice_value,
              COALESCE(SUM(total_taxable_sale_value),0) AS total_taxable_sale_value,
              COALESCE(SUM(tax_amount),0) AS tax_amount,
              COALESCE(SUM(quantity),0) AS quantity
       FROM col_meesho_sales WHERE ${where}`,
      params
    );
    const rows = await query(
      `SELECT * FROM col_meesho_sales WHERE ${where} ORDER BY order_date DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, skip]
    );

    res.json({
      total: Number(totalRow[0]?.n || 0),
      rows,
      totals: {
        total_invoice_value: Number(totals[0]?.total_invoice_value || 0),
        total_taxable_sale_value: Number(totals[0]?.total_taxable_sale_value || 0),
        tax_amount: Number(totals[0]?.tax_amount || 0),
        quantity: Number(totals[0]?.quantity || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---- row delete (single) ----

// ---- bank transactions ----

router.get("/bank/banks", async (_req, res, next) => {
  try {
    const rows = await query<{ bank_name: string }>(
      "SELECT DISTINCT bank_name FROM col_bank_txns WHERE bank_name IS NOT NULL ORDER BY bank_name"
    );
    res.json(rows.map((r) => r.bank_name));
  } catch (err) {
    next(err);
  }
});

router.get("/bank", async (req, res, next) => {
  try {
    const q = req.query as any;
    const skip = Math.max(0, Number(q.skip) || 0);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const w: string[] = ["1=1"];
    const p: any[] = [];
    if (q.id) {
      w.push("b.id = ?");
      p.push(Number(q.id));
    }
    if (q.company_id) {
      w.push("b.company_id = ?");
      p.push(Number(q.company_id));
    }
    if (q.search) {
      w.push("(b.description LIKE ? OR b.ref_number LIKE ?)");
      p.push(`%${q.search}%`, `%${q.search}%`);
    }
    if (q.bank_name) {
      w.push("b.bank_name = ?");
      p.push(q.bank_name);
    }
    if (q.txn_kind === "debit") w.push("b.debit > 0");
    else if (q.txn_kind === "credit") w.push("b.credit > 0");
    if (q.date_from) {
      w.push("b.transaction_date >= ?");
      p.push(q.date_from);
    }
    if (q.date_to) {
      w.push("b.transaction_date <= ?");
      p.push(q.date_to);
    }
    if (q.uncategorized === "true" || q.uncategorized === "1") w.push("b.ledger_head_id IS NULL");
    else if (q.ledger_head_id) {
      w.push("b.ledger_head_id = ?");
      p.push(Number(q.ledger_head_id));
    } else if (q.group_id) {
      w.push("b.ledger_head_id IN (SELECT id FROM col_ledgers WHERE group_id = ?)");
      p.push(Number(q.group_id));
    }
    const where = w.join(" AND ");

    const [c] = await query<{ n: number }>(
      `SELECT COUNT(*) n FROM col_bank_txns b WHERE ${where}`,
      p
    );
    const rows = await query<any>(
      `SELECT b.id, b.transaction_date, b.value_date, b.description, b.ref_number,
              b.debit, b.credit, b.balance, b.bank_name, b.account_number, b.platform,
              b.ledger_head_id, l.name ledger_head_name, l.color ledger_head_color,
              g.name ledger_group_name
       FROM col_bank_txns b
       LEFT JOIN col_ledgers l ON l.id = b.ledger_head_id
       LEFT JOIN col_ledger_groups g ON g.id = l.group_id
       WHERE ${where}
       ORDER BY b.transaction_date DESC, b.id DESC
       LIMIT ? OFFSET ?`,
      [...p, limit, skip]
    );
    const [t] = await query<any>(
      `SELECT COALESCE(SUM(debit),0) debit, COALESCE(SUM(credit),0) credit
       FROM col_bank_txns b WHERE ${where}`,
      p
    );
    res.json({
      total: Number(c?.n || 0),
      rows,
      totals: { debit: Number(t?.debit || 0), credit: Number(t?.credit || 0) },
    });
  } catch (err) {
    next(err);
  }
});

const DELETE_TABLE: Record<string, string> = {
  amazon: "col_amazon_mtr",
  flipkart: "col_flipkart_sales",
  meesho: "col_meesho_sales",
  bank: "col_bank_txns",
};

router.delete("/:platform/:id", async (req, res, next) => {
  try {
    const table = DELETE_TABLE[req.params.platform];
    if (!table) {
      res.status(400).json({ error: "Unknown platform" });
      return;
    }
    await query(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
    res.json({ status: "deleted" });
  } catch (err) {
    next(err);
  }
});

export default router;
