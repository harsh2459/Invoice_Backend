/**
 * Unified document feed for the Invoicing list: sales invoices, payment
 * receipts, and sales returns, one row each, newest first.
 *
 *   GET /api/documents?type=&company_id=&client_id=&q=&from=&to=
 *     type: "" | "sales" | "receipt" | "return"
 */
import { Router } from "express";
import { query } from "../db";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const type = String(req.query.type || "");
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const clientId = req.query.client_id ? Number(req.query.client_id) : null;
    const q = (req.query.q as string | undefined)?.trim();
    const from = (req.query.from as string) || "";
    const to = (req.query.to as string) || "";
    const like = q ? `%${q}%` : null;

    const rows: any[] = [];

    // ---- sales invoices ----
    if (!type || type === "sales") {
      const w: string[] = ["1=1"];
      const p: any[] = [];
      if (companyId) (w.push("i.company_id = ?"), p.push(companyId));
      if (clientId) (w.push("i.client_id = ?"), p.push(clientId));
      if (from) (w.push("i.invoice_date >= ?"), p.push(from));
      if (to) (w.push("i.invoice_date <= ?"), p.push(to));
      if (like) {
        w.push("(i.number LIKE ? OR cl.name LIKE ? OR co.name LIKE ? OR cl.phone LIKE ?)");
        p.push(like, like, like, like);
      }
      const inv = await query<any>(
        `SELECT i.id, 'sales' AS doc_type, i.number, i.invoice_date AS date, i.total,
                i.amount_paid, (i.total - i.amount_paid) AS balance, i.payment_status,
                i.company_id, i.client_id, co.name AS company_name,
                cl.name AS client_name, cl.phone AS client_phone
           FROM invoices i
           LEFT JOIN companies co ON co.id = i.company_id
           LEFT JOIN clients cl ON cl.id = i.client_id
          WHERE ${w.join(" AND ")}`,
        p
      );
      rows.push(...inv);
    }

    // ---- payment receipts ----
    if (!type || type === "receipt") {
      const w: string[] = ["1=1"];
      const p: any[] = [];
      if (companyId) (w.push("r.company_id = ?"), p.push(companyId));
      if (clientId) (w.push("r.client_id = ?"), p.push(clientId));
      if (from) (w.push("r.receipt_date >= ?"), p.push(from));
      if (to) (w.push("r.receipt_date <= ?"), p.push(to));
      if (like) {
        w.push("(r.number LIKE ? OR cl.name LIKE ? OR cl.phone LIKE ?)");
        p.push(like, like, like);
      }
      const rec = await query<any>(
        `SELECT r.id, 'receipt' AS doc_type, r.number, r.receipt_date AS date,
                r.amount AS total, r.amount AS amount_paid, 0 AS balance,
                'paid' AS payment_status, r.company_id, r.client_id, r.mode, r.reference,
                r.unapplied, co.name AS company_name,
                cl.name AS client_name, cl.phone AS client_phone
           FROM client_receipts r
           LEFT JOIN companies co ON co.id = r.company_id
           LEFT JOIN clients cl ON cl.id = r.client_id
          WHERE ${w.join(" AND ")}`,
        p
      );
      rows.push(...rec);
    }

    // ---- sales returns ----
    if (!type || type === "return") {
      const w: string[] = ["1=1"];
      const p: any[] = [];
      if (companyId) (w.push("sr.company_id = ?"), p.push(companyId));
      if (clientId) (w.push("sr.client_id = ?"), p.push(clientId));
      if (from) (w.push("sr.return_date >= ?"), p.push(from));
      if (to) (w.push("sr.return_date <= ?"), p.push(to));
      if (like) {
        w.push("(sr.number LIKE ? OR cl.name LIKE ? OR cl.phone LIKE ?)");
        p.push(like, like, like);
      }
      const ret = await query<any>(
        `SELECT sr.id, 'return' AS doc_type, sr.number, sr.return_date AS date,
                sr.total, 0 AS amount_paid, 0 AS balance, 'paid' AS payment_status,
                sr.company_id, sr.client_id, sr.reason, sr.restock, sr.invoice_id,
                co.name AS company_name, cl.name AS client_name, cl.phone AS client_phone,
                i.number AS against_invoice
           FROM sales_returns sr
           LEFT JOIN companies co ON co.id = sr.company_id
           LEFT JOIN clients cl ON cl.id = sr.client_id
           LEFT JOIN invoices i ON i.id = sr.invoice_id
          WHERE ${w.join(" AND ")}`,
        p
      );
      rows.push(...ret);
    }

    rows.sort((a, b) => {
      const d = String(b.date).localeCompare(String(a.date));
      return d !== 0 ? d : b.id - a.id;
    });

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
