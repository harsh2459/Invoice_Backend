/**
 * Purchase invoices (supplier bills). Mirrors routes/invoices.ts, with two
 * differences:
 *   - `number` is the SUPPLIER'S bill number (free text, required) — no auto seq
 *   - payments here are money YOU paid out (purchase_payments)
 */
import { Router } from "express";
import { query, exec, withTransaction } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import { computeTotals, paymentStatus, recomputePurchasePayment, type RawItem } from "../invoiceMath";
import { applyStockForDocument, reverseStockForDocument } from "../stock";

const router = Router();
router.use(authenticate);

function parseItems(body: any): RawItem[] {
  const raw = Array.isArray(body.items) ? body.items : [];
  return raw.map((it: any) => ({
    product_id: it.product_id ? Number(it.product_id) : null,
    description: (it.description || "").trim(),
    hsn: (it.hsn || "").trim() || null,
    qty: Number(it.qty ?? 0),
    rate: Number(it.rate ?? 0),
    gst_rate: Number(it.gst_rate ?? 0),
  }));
}

// ---- list ----

router.get("/", async (req: AuthRequest, res, next) => {
  try {
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    const status = req.query.status as string | undefined;
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const supplierId = req.query.supplier_id ? Number(req.query.supplier_id) : null;
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    if (start && end) {
      clauses.push("p.bill_date >= ? AND p.bill_date <= ?");
      params.push(start, end);
    }
    if (status && ["unpaid", "partial", "paid"].includes(status)) {
      clauses.push("p.payment_status = ?");
      params.push(status);
    }
    if (companyId) {
      clauses.push("p.company_id = ?");
      params.push(companyId);
    }
    if (supplierId) {
      clauses.push("p.supplier_id = ?");
      params.push(supplierId);
    }
    const rows = await query(
      `SELECT p.id, p.bill_date, p.due_date, p.number, p.total, p.amount_paid,
              p.payment_status, (p.total - p.amount_paid) AS balance,
              p.company_id, p.supplier_id,
              co.name AS company_name, s.name AS supplier_name
       FROM purchase_invoices p
       LEFT JOIN companies co ON co.id = p.company_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY p.bill_date DESC, p.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---- view ----

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT p.*, (p.total - p.amount_paid) AS balance,
              co.name AS company_name, s.name AS supplier_name, s.gstin AS supplier_gstin,
              s.address AS supplier_address, s.phone AS supplier_phone, s.email AS supplier_email
       FROM purchase_invoices p
       LEFT JOIN companies co ON co.id = p.company_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.id = ?`,
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Bill not found" });
      return;
    }
    const items = await query(
      "SELECT id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount FROM purchase_invoice_items WHERE purchase_invoice_id = ? ORDER BY id",
      [req.params.id]
    );
    const payments = await query(
      `SELECT pp.id, pp.paid_on, pp.amount, pp.bank_account_id,
              ba.name AS bank_name, ba.last4 AS bank_last4
       FROM purchase_payments pp
       LEFT JOIN bank_accounts ba ON ba.id = pp.bank_account_id
       WHERE pp.purchase_invoice_id = ?
       ORDER BY pp.paid_on, pp.id`,
      [req.params.id]
    );
    res.json({ ...rows[0], items, payments });
  } catch (err) {
    next(err);
  }
});

// ---- create ----

router.post("/", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const { company_id, supplier_id, bill_date, due_date, number, notes } = req.body;
    const discount = Number(req.body.discount ?? 0);
    const discountIsPct = req.body.discount_is_pct !== false && req.body.discount_is_pct !== 0;
    const items = parseItems(req.body);

    if (!company_id || !supplier_id || !bill_date) {
      res.status(400).json({ error: "Company, supplier and bill date are required" });
      return;
    }
    if (!(number || "").trim()) {
      res.status(400).json({ error: "The supplier's bill number is required" });
      return;
    }
    if (items.length === 0) {
      res.status(400).json({ error: "Add at least one line item" });
      return;
    }
    if (items.some((it) => !it.description)) {
      res.status(400).json({ error: "Every line item needs a description" });
      return;
    }

    const t = computeTotals(items, discount, discountIsPct);

    const bill = await withTransaction(async (tx) => {
      const header = await tx.exec(
        `INSERT INTO purchase_invoices
           (company_id, supplier_id, bill_date, due_date, number, notes,
            subtotal, discount, discount_is_pct, discount_value, tax_total, total,
            amount_paid, payment_status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
        [
          company_id,
          supplier_id,
          bill_date,
          due_date || null,
          String(number).trim(),
          notes || null,
          t.subtotal,
          discount,
          discountIsPct ? 1 : 0,
          t.discount_value,
          t.tax_total,
          t.total,
          req.user!.id,
        ]
      );
      for (const it of t.items) {
        await tx.exec(
          `INSERT INTO purchase_invoice_items
             (purchase_invoice_id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            header.insertId,
            it.product_id,
            it.description,
            it.hsn,
            it.qty,
            it.rate,
            it.amount,
            it.gst_rate,
            it.tax_amount,
          ]
        );
      }
      // stock IN
      await applyStockForDocument(tx, {
        lines: t.items.map((it) => ({ product_id: it.product_id, qty: it.qty })),
        direction: 1,
        refType: "purchase_invoice",
        refId: header.insertId,
        userId: req.user!.id,
        note: `Bill ${String(number).trim()}`,
      });
      return { id: header.insertId, number: String(number).trim(), total: t.total };
    });

    res.json(bill);
  } catch (err) {
    next(err);
  }
});

// ---- update ----

router.put("/:id", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const existing = await query<any>("SELECT * FROM purchase_invoices WHERE id = ?", [
      req.params.id,
    ]);
    if (!existing[0]) {
      res.status(404).json({ error: "Bill not found" });
      return;
    }
    const { company_id, supplier_id, bill_date, due_date, number, notes } = req.body;
    const discount = Number(req.body.discount ?? 0);
    const discountIsPct = req.body.discount_is_pct !== false && req.body.discount_is_pct !== 0;
    const items = parseItems(req.body);

    if (!company_id || !supplier_id || !bill_date) {
      res.status(400).json({ error: "Company, supplier and bill date are required" });
      return;
    }
    if (items.length === 0) {
      res.status(400).json({ error: "Add at least one line item" });
      return;
    }
    if (items.some((it) => !it.description)) {
      res.status(400).json({ error: "Every line item needs a description" });
      return;
    }

    const t = computeTotals(items, discount, discountIsPct);
    const paid = Number(existing[0].amount_paid || 0);
    const status = paymentStatus(t.total, paid);

    await withTransaction(async (tx) => {
      await tx.exec(
        `UPDATE purchase_invoices SET
           company_id = ?, supplier_id = ?, bill_date = ?, due_date = ?, number = ?, notes = ?,
           subtotal = ?, discount = ?, discount_is_pct = ?, discount_value = ?,
           tax_total = ?, total = ?, payment_status = ?
         WHERE id = ?`,
        [
          company_id,
          supplier_id,
          bill_date,
          due_date || null,
          (number || "").trim() || existing[0].number,
          notes || null,
          t.subtotal,
          discount,
          discountIsPct ? 1 : 0,
          t.discount_value,
          t.tax_total,
          t.total,
          status,
          req.params.id,
        ]
      );
      await tx.exec("DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = ?", [
        req.params.id,
      ]);
      for (const it of t.items) {
        await tx.exec(
          `INSERT INTO purchase_invoice_items
             (purchase_invoice_id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.params.id,
            it.product_id,
            it.description,
            it.hsn,
            it.qty,
            it.rate,
            it.amount,
            it.gst_rate,
            it.tax_amount,
          ]
        );
      }
      // re-diff stock: undo the old lines, apply the new ones
      await reverseStockForDocument(tx, "purchase_invoice", Number(req.params.id));
      await applyStockForDocument(tx, {
        lines: t.items.map((it) => ({ product_id: it.product_id, qty: it.qty })),
        direction: 1,
        refType: "purchase_invoice",
        refId: Number(req.params.id),
        userId: req.user!.id,
        note: `Bill ${(number || "").trim() || existing[0].number}`,
      });
    });

    res.json({ id: Number(req.params.id), total: t.total, payment_status: status });
  } catch (err) {
    next(err);
  }
});

// ---- payments (money you paid the supplier) ----

router.get("/:id/payments", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT pp.id, pp.paid_on, pp.amount, pp.bank_account_id,
              ba.name AS bank_name, ba.last4 AS bank_last4
       FROM purchase_payments pp
       LEFT JOIN bank_accounts ba ON ba.id = pp.bank_account_id
       WHERE pp.purchase_invoice_id = ?
       ORDER BY pp.paid_on, pp.id`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/payment", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const bill = await query<any>(
      "SELECT id, company_id, total, amount_paid FROM purchase_invoices WHERE id = ?",
      [req.params.id]
    );
    if (!bill[0]) {
      res.status(404).json({ error: "Bill not found" });
      return;
    }

    let amount: number;
    if (req.body.amount != null) amount = Number(req.body.amount);
    else if (req.body.amount_paid != null)
      amount = Number(req.body.amount_paid) - Number(bill[0].amount_paid || 0);
    else {
      res.status(400).json({ error: "Provide an amount" });
      return;
    }
    if (!(amount > 0)) {
      res.status(400).json({ error: "Amount must be greater than zero" });
      return;
    }
    amount = Math.round((amount + Number.EPSILON) * 100) / 100;

    const paidOn = (req.body.paid_on as string) || new Date().toISOString().slice(0, 10);
    const bankAccountId = req.body.bank_account_id ? Number(req.body.bank_account_id) : null;

    if (bankAccountId) {
      const ba = await query<any>("SELECT company_id FROM bank_accounts WHERE id = ?", [
        bankAccountId,
      ]);
      if (!ba[0]) {
        res.status(400).json({ error: "Bank account not found" });
        return;
      }
      if (Number(ba[0].company_id) !== Number(bill[0].company_id)) {
        res.status(400).json({ error: "That bank account is not for this bill's company" });
        return;
      }
    }

    const result = await withTransaction(async (tx) => {
      await tx.exec(
        "INSERT INTO purchase_payments (purchase_invoice_id, bank_account_id, paid_on, amount, created_by) VALUES (?, ?, ?, ?, ?)",
        [req.params.id, bankAccountId, paidOn, amount, req.user!.id]
      );
      return recomputePurchasePayment(tx, Number(req.params.id));
    });

    res.json({ id: Number(req.params.id), ...result });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/payments/:paymentId", requireAdmin, async (req, res, next) => {
  try {
    const result = await withTransaction(async (tx) => {
      const del = await tx.exec(
        "DELETE FROM purchase_payments WHERE id = ? AND purchase_invoice_id = ?",
        [req.params.paymentId, req.params.id]
      );
      if (del.affectedRows === 0) return null;
      return recomputePurchasePayment(tx, Number(req.params.id));
    });
    if (!result) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    res.json({ id: Number(req.params.id), ...result });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await withTransaction(async (tx) => {
      await reverseStockForDocument(tx, "purchase_invoice", Number(req.params.id));
      await tx.exec("DELETE FROM purchase_invoices WHERE id = ?", [req.params.id]); // items cascade
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
