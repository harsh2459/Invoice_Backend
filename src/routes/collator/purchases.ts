/**
 * Collator fee-invoices (imported Amazon fee/ad bills) — port of Drogon
 * `routes/purchases.py`. Table: col_fee_invoices.
 *
 *   GET  /            paginated list + totals   (search, invoice_type, company_id, year, month)
 *   DELETE /:id       remove one row
 *   PUT  /:id/paid    { is_paid, paid_date? }   toggle payment
 *   GET  /aging       unpaid, bucketed 0-30 / 31-60 / 61-90 / 90+  + vendor summary
 */
import { Router } from "express";
import { query, exec } from "../../db";

const router = Router();
const r2 = (n: unknown) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

function listFilters(q: any): { where: string; params: any[] } {
  const w: string[] = ["1=1"];
  const p: any[] = [];
  if (q.company_id) {
    w.push("company_id = ?");
    p.push(Number(q.company_id));
  }
  if (q.year) {
    w.push("data_year = ?");
    p.push(Number(q.year));
  }
  if (q.month) {
    w.push("data_month = ?");
    p.push(Number(q.month));
  }
  if (q.invoice_type) {
    w.push("invoice_type LIKE ?");
    p.push(`%${q.invoice_type}%`);
  }
  if (q.search) {
    w.push("(invoice_number LIKE ? OR description LIKE ? OR vendor LIKE ?)");
    const s = `%${q.search}%`;
    p.push(s, s, s);
  }
  return { where: w.join(" AND "), params: p };
}

router.get("/", async (req, res, next) => {
  try {
    const { where, params } = listFilters(req.query);
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const [countRow] = await query<{ n: number }>(
      `SELECT COUNT(*) n FROM col_fee_invoices WHERE ${where}`,
      params
    );
    const rows = await query<any>(
      `SELECT * FROM col_fee_invoices WHERE ${where}
       ORDER BY invoice_date DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, skip]
    );
    const [t] = await query<any>(
      `SELECT COALESCE(SUM(taxable_amount),0) taxable,
              COALESCE(SUM(igst_amount),0) igst,
              COALESCE(SUM(total_amount),0) total
       FROM col_fee_invoices WHERE ${where}`,
      params
    );

    res.json({
      total: Number(countRow?.n || 0),
      rows,
      totals: {
        taxable_amount: r2(t?.taxable),
        igst_amount: r2(t?.igst),
        total_amount: r2(t?.total),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const r = await exec("DELETE FROM col_fee_invoices WHERE id = ?", [req.params.id]);
    if (r.affectedRows === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ status: "deleted" });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/paid", async (req, res, next) => {
  try {
    const isPaid = req.body.is_paid === true || req.body.is_paid === 1 || req.body.is_paid === "1";
    let paidDate: string | null = null;
    if (isPaid) {
      const d = String(req.body.paid_date || "").trim();
      paidDate = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
    }
    const r = await exec(
      "UPDATE col_fee_invoices SET is_paid = ?, paid_date = ? WHERE id = ?",
      [isPaid ? 1 : 0, paidDate, req.params.id]
    );
    if (r.affectedRows === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ id: Number(req.params.id), is_paid: isPaid, paid_date: paidDate });
  } catch (err) {
    next(err);
  }
});

router.get("/aging", async (req, res, next) => {
  try {
    const w: string[] = ["is_paid = 0"];
    const p: any[] = [];
    if (req.query.company_id) {
      w.push("company_id = ?");
      p.push(Number(req.query.company_id));
    }
    const rows = await query<any>(
      `SELECT id, invoice_number, invoice_date, vendor, total_amount
       FROM col_fee_invoices WHERE ${w.join(" AND ")}
       ORDER BY invoice_date ASC`,
      p
    );

    const today = new Date();
    const buckets: Record<string, any[]> = { "0-30": [], "31-60": [], "61-90": [], "90+": [] };
    const bucketTotals: Record<string, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    const vendorTotals = new Map<string, number>();

    for (const inv of rows) {
      if (!inv.invoice_date) continue;
      const d = new Date(inv.invoice_date);
      const days = Math.floor((today.getTime() - d.getTime()) / 86400000);
      const key = days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
      const amount = Number(inv.total_amount || 0);
      buckets[key].push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_date: String(inv.invoice_date).slice(0, 10),
        vendor: inv.vendor,
        total_amount: r2(amount),
        days_outstanding: days,
      });
      bucketTotals[key] += amount;
      const v = inv.vendor || "Unknown Vendor";
      vendorTotals.set(v, (vendorTotals.get(v) || 0) + amount);
    }

    const vendor_summary = [...vendorTotals.entries()]
      .map(([vendor, total_outstanding]) => ({ vendor, total_outstanding: r2(total_outstanding) }))
      .sort((a, b) => b.total_outstanding - a.total_outstanding);

    res.json({
      buckets,
      bucket_totals: Object.fromEntries(
        Object.entries(bucketTotals).map(([k, v]) => [k, r2(v)])
      ),
      total_outstanding: r2(Object.values(bucketTotals).reduce((s, v) => s + v, 0)),
      vendor_summary,
      invoice_count: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
