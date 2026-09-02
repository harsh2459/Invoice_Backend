/**
 * Sales returns (credit notes). A customer sends goods back:
 *   - reduces their ledger balance by the return value (one credit entry)
 *   - restocks inventory unless the goods were damaged
 *
 *   GET  /api/returns                 list (filters: client_id, company_id, q)
 *   GET  /api/returns/:id             one return + items
 *   POST /api/returns                 create
 *   DELETE /api/returns/:id           delete (reverses ledger + stock)
 *   GET  /api/returns/:id/pdf         credit-note PDF
 */
import { Router } from "express";
import { query, withTransaction } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import { computeTotals, formatInvoiceNumber, round2, type RawItem } from "../invoiceMath";
import { applyStockForDocument, reverseStockForDocument } from "../stock";
import { postEntry, voidEntriesFor, partyBalance } from "../ledger";
import { renderReturnPdf } from "../returnPdf";

const router = Router();
router.use(authenticate);

function parseItems(body: any): RawItem[] {
  const raw = Array.isArray(body.items) ? body.items : [];
  return raw
    .map((it: any) => ({
      product_id: it.product_id ? Number(it.product_id) : null,
      description: (it.description || "").trim(),
      hsn: (it.hsn || "").trim() || null,
      qty: Number(it.qty ?? 0),
      rate: Number(it.rate ?? 0),
      gst_rate: Number(it.gst_rate ?? 0),
    }))
    .filter((it: RawItem) => it.description && it.qty > 0);
}

const like = (s: string) => `%${s}%`;

router.get("/", async (req, res, next) => {
  try {
    const w: string[] = ["1=1"];
    const p: any[] = [];
    if (req.query.client_id) {
      w.push("r.client_id = ?");
      p.push(Number(req.query.client_id));
    }
    if (req.query.company_id) {
      w.push("r.company_id = ?");
      p.push(Number(req.query.company_id));
    }
    if (req.query.q) {
      w.push("(r.number LIKE ? OR cl.name LIKE ?)");
      p.push(like(String(req.query.q)), like(String(req.query.q)));
    }
    const rows = await query<any>(
      `SELECT r.id, r.number, r.return_date, r.reason, r.restock, r.total, r.notes,
              r.client_id, r.company_id, r.invoice_id,
              cl.name AS client_name, cl.phone AS client_phone,
              co.name AS company_name, i.number AS invoice_number
         FROM sales_returns r
         LEFT JOIN clients cl ON cl.id = r.client_id
         LEFT JOIN companies co ON co.id = r.company_id
         LEFT JOIN invoices i ON i.id = r.invoice_id
        WHERE ${w.join(" AND ")}
        ORDER BY r.return_date DESC, r.id DESC`,
      p
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT r.*, cl.name AS client_name, cl.phone AS client_phone, cl.address AS client_address,
              cl.gstin AS client_gstin, cl.email AS client_email,
              co.name AS company_name, i.number AS invoice_number
         FROM sales_returns r
         LEFT JOIN clients cl ON cl.id = r.client_id
         LEFT JOIN companies co ON co.id = r.company_id
         LEFT JOIN invoices i ON i.id = r.invoice_id
        WHERE r.id = ?`,
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Return not found" });
      return;
    }
    const items = await query(
      "SELECT id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount FROM sales_return_items WHERE sales_return_id = ? ORDER BY id",
      [req.params.id]
    );
    const current_balance = await partyBalance("client", Number(rows[0].client_id));
    const previous_balance = Math.round((current_balance + Number(rows[0].total)) * 100) / 100;
    res.json({ ...rows[0], items, previous_balance, current_balance });
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const companyId = Number(req.body.company_id);
    const clientId = Number(req.body.client_id);
    const invoiceId = req.body.invoice_id ? Number(req.body.invoice_id) : null;
    const reason = ["damaged", "wrong_item", "excess", "not_needed", "other"].includes(
      req.body.reason
    )
      ? req.body.reason
      : "other";
    const restock = reason === "damaged" ? 0 : req.body.restock === false ? 0 : 1;
    const notes = (req.body.notes || "").trim() || null;
    const items = parseItems(req.body);

    if (!companyId || !clientId) {
      res.status(400).json({ error: "Company and client are required" });
      return;
    }
    if (items.length === 0) {
      res.status(400).json({ error: "Add at least one returned item" });
      return;
    }

    const returnDate = new Date().toISOString().slice(0, 10);
    const t = computeTotals(items, 0, true);

    const result = await withTransaction(async (tx) => {
      const year = new Date().getFullYear();
      await tx.exec(
        `INSERT INTO invoice_counters (company_id, year, seq) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE seq = seq + 1`,
        [companyId, year]
      );
      const [ctr] = await tx.query<any>(
        "SELECT seq FROM invoice_counters WHERE company_id = ? AND year = ?",
        [companyId, year]
      );
      const number = formatInvoiceNumber("SRET", "SRET", year, ctr.seq);

      const head = await tx.exec(
        `INSERT INTO sales_returns
           (client_id, company_id, invoice_id, number, return_date, reason, restock,
            subtotal, tax_total, total, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clientId,
          companyId,
          invoiceId,
          number,
          returnDate,
          reason,
          restock,
          t.subtotal,
          t.tax_total,
          t.total,
          notes,
          req.user!.id,
        ]
      );
      const rid = head.insertId!;

      for (const it of t.items) {
        await tx.exec(
          `INSERT INTO sales_return_items
             (sales_return_id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [rid, it.product_id, it.description, it.hsn, it.qty, it.rate, it.amount, it.gst_rate, it.tax_amount]
        );
      }

      if (restock) {
        await applyStockForDocument(tx, {
          lines: t.items.map((it) => ({ product_id: it.product_id, qty: it.qty })),
          direction: +1, // goods come back IN
          refType: "sales_return",
          refId: rid,
          userId: req.user!.id,
          note: `Sales Return ${number}`,
        });
      }

      const [co] = await tx.query<any>("SELECT name FROM companies WHERE id = ?", [companyId]);
      await postEntry(tx, {
        partyType: "client",
        partyId: clientId,
        companyId,
        date: returnDate,
        sourceType: "sales_return",
        sourceId: rid,
        particulars: `Sales Return${co?.name ? ` — ${co.name}` : ""}${
          reason !== "other" ? ` (${reason.replace("_", " ")})` : ""
        }`,
        ref: number,
        credit: t.total, // customer owes us less
        userId: req.user!.id,
      });

      const client_balance = await partyBalance("client", clientId, { runner: tx });
      return { id: rid, number, total: t.total, restock: !!restock, client_balance };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ok = await withTransaction(async (tx) => {
      const [r] = await tx.query<any>(
        "SELECT id, client_id, restock FROM sales_returns WHERE id = ?",
        [id]
      );
      if (!r) return null;
      if (r.restock) await reverseStockForDocument(tx, "sales_return", id);
      await voidEntriesFor(tx, "sales_return", id);
      await tx.exec("DELETE FROM sales_returns WHERE id = ?", [id]); // items cascade
      return r.client_id;
    });
    if (ok == null) {
      res.status(404).json({ error: "Return not found" });
      return;
    }
    res.json({ ok: true, client_balance: await partyBalance("client", Number(ok)) });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/pdf", async (req, res, next) => {
  try {
    const { buffer, filename } = await renderReturnPdf(req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.send(buffer);
  } catch (err: any) {
    if (err?.code === "RETURN_NOT_FOUND") {
      res.status(404).send("Return not found");
      return;
    }
    next(err);
  }
});

export default router;
