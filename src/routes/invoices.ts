import { Router } from "express";
import { query, exec, withTransaction } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import {
  computeTotals,
  paymentStatus,
  formatInvoiceNumber,
  recomputeInvoicePayment,
  previousClientBalance,
  round2,
  type RawItem,
} from "../invoiceMath";
import { renderInvoicePdf } from "../invoicePdf";
import { applyStockForDocument, reverseStockForDocument } from "../stock";
import { postEntry, voidEntriesFor, partyBalance } from "../ledger";

const router = Router();
router.use(authenticate);

// Normalise line items from the request body.
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
    const clientId = req.query.client_id ? Number(req.query.client_id) : null;
    const q = (req.query.q as string | undefined)?.trim();
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    if (q) {
      clauses.push("(i.number LIKE ? OR cl.name LIKE ? OR co.name LIKE ? OR cl.phone LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (start && end) {
      clauses.push("i.invoice_date >= ? AND i.invoice_date <= ?");
      params.push(start, end);
    }
    if (status && ["unpaid", "partial", "paid"].includes(status)) {
      clauses.push("i.payment_status = ?");
      params.push(status);
    }
    if (companyId) {
      clauses.push("i.company_id = ?");
      params.push(companyId);
    }
    if (clientId) {
      clauses.push("i.client_id = ?");
      params.push(clientId);
    }
    const rows = await query(
      `SELECT i.id, i.invoice_date, i.due_date, i.number, i.total, i.amount_paid,
              i.payment_status, (i.total - i.amount_paid) AS balance,
              i.company_id, i.client_id,
              co.name AS company_name, cl.name AS client_name, cl.phone AS client_phone
       FROM invoices i
       LEFT JOIN companies co ON co.id = i.company_id
       LEFT JOIN clients cl ON cl.id = i.client_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY i.invoice_date DESC, i.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---- next auto number for a company (form helper) ----

router.get("/next-number/:companyId", async (req, res, next) => {
  try {
    const co = await query<any>(
      "SELECT name, invoice_prefix FROM companies WHERE id = ?",
      [req.params.companyId]
    );
    if (!co[0]) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const year = new Date().getFullYear();
    const ctr = await query<any>(
      "SELECT seq FROM invoice_counters WHERE company_id = ? AND year = ?",
      [req.params.companyId, year]
    );
    const nextSeq = (ctr[0]?.seq ?? 0) + 1;
    res.json({
      number: formatInvoiceNumber(co[0].invoice_prefix, co[0].name, year, nextSeq),
    });
  } catch (err) {
    next(err);
  }
});

// ---- client's outstanding balance (form helper) ----
// True ledger balance across all companies.

router.get("/client-balance", async (req, res, next) => {
  try {
    const clientId = Number(req.query.client_id);
    if (!clientId) {
      res.json({ prior_due: 0 });
      return;
    }
    res.json({ prior_due: await partyBalance("client", clientId) });
  } catch (err) {
    next(err);
  }
});

// ---- view ----

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT i.*, (i.total - i.amount_paid) AS balance,
              co.name AS company_name, co.address AS company_address, co.phone AS company_phone,
              co.email AS company_email, co.gstin AS company_gstin, co.logo AS company_logo,
              cl.name AS client_name, cl.phone AS client_phone, cl.address AS client_address,
              cl.gstin AS client_gstin, cl.email AS client_email
       FROM invoices i
       LEFT JOIN companies co ON co.id = i.company_id
       LEFT JOIN clients cl ON cl.id = i.client_id
       WHERE i.id = ?`,
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const items = await query(
      "SELECT id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount FROM invoice_items WHERE invoice_id = ? ORDER BY id",
      [req.params.id]
    );
    const payments = await query(
      `SELECT ip.id, ip.paid_on, ip.amount, ip.mode, ip.reference, ip.bank_account_id,
              ba.name AS bank_name, ba.last4 AS bank_last4
       FROM invoice_payments ip
       LEFT JOIN bank_accounts ba ON ba.id = ip.bank_account_id
       WHERE ip.invoice_id = ?
       ORDER BY ip.paid_on, ip.id`,
      [req.params.id]
    );

    // return created on the same document (POST /invoices with return_items)
    const [linkedReturn] = await query<any>(
      `SELECT id, number, return_date, reason, restock, subtotal, tax_total, total, notes
         FROM sales_returns WHERE invoice_id = ? ORDER BY id LIMIT 1`,
      [req.params.id]
    );
    let returnItems: any[] = [];
    if (linkedReturn) {
      returnItems = await query(
        "SELECT id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount FROM sales_return_items WHERE sales_return_id = ? ORDER BY id",
        [linkedReturn.id]
      );
    }

    const inv = rows[0];
    const previous_balance = await previousClientBalance(
      { query },
      {
        clientId: inv.client_id,
        invoiceDate: String(inv.invoice_date).slice(0, 10),
        invoiceId: inv.id,
      }
    );
    const current_balance = round2(previous_balance + Number(inv.balance || 0));

    res.json({
      ...inv,
      items,
      payments,
      previous_balance,
      current_balance,
      linked_return: linkedReturn ? { ...linkedReturn, items: returnItems } : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---- create ----

router.post("/", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const { company_id, client_id, due_date, number, notes } = req.body;
    // New invoices are always dated today — no back- or post-dating.
    const invoice_date = new Date().toISOString().slice(0, 10);
    const discount = Number(req.body.discount ?? 0);
    const discountIsPct = req.body.discount_is_pct !== false && req.body.discount_is_pct !== 0;
    const items = parseItems(req.body);

    if (!company_id || !client_id) {
      res.status(400).json({ error: "Company and client are required" });
      return;
    }
    if (due_date && String(due_date).slice(0, 10) < invoice_date) {
      res.status(400).json({ error: "Due date cannot be before today" });
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

    const invoice = await withTransaction(async (tx) => {
      let finalNumber = (number || "").trim();
      const year = new Date().getFullYear();

      // Always bump the counter so the sequence has no gaps; use it for the
      // number only when the user didn't supply one.
      await tx.exec(
        `INSERT INTO invoice_counters (company_id, year, seq) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE seq = seq + 1`,
        [company_id, year]
      );
      const ctr = await tx.query<any>(
        "SELECT seq FROM invoice_counters WHERE company_id = ? AND year = ?",
        [company_id, year]
      );
      const seq = ctr[0].seq;

      if (!finalNumber) {
        const co = await tx.query<any>(
          "SELECT name, invoice_prefix FROM companies WHERE id = ?",
          [company_id]
        );
        finalNumber = formatInvoiceNumber(
          co[0]?.invoice_prefix ?? null,
          co[0]?.name ?? "INV",
          year,
          seq
        );
      }

      const header = await tx.exec(
        `INSERT INTO invoices
           (company_id, client_id, invoice_date, due_date, number, notes,
            subtotal, discount, discount_is_pct, discount_value, tax_total, total,
            amount_paid, payment_status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?)`,
        [
          company_id,
          client_id,
          invoice_date,
          due_date || null,
          finalNumber,
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
          `INSERT INTO invoice_items
             (invoice_id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount)
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
      // stock OUT
      await applyStockForDocument(tx, {
        lines: t.items.map((it) => ({ product_id: it.product_id, qty: it.qty })),
        direction: -1,
        refType: "invoice",
        refId: header.insertId,
        userId: req.user!.id,
        note: `Invoice ${finalNumber}`,
      });

      // LEDGER: the sale — customer owes us `total`
      const coRow = await tx.query<any>("SELECT name FROM companies WHERE id = ?", [company_id]);
      await postEntry(tx, {
        partyType: "client",
        partyId: Number(client_id),
        companyId: Number(company_id),
        date: invoice_date,
        sourceType: "invoice",
        sourceId: header.insertId,
        particulars: `Sales Invoice${coRow[0]?.name ? ` — ${coRow[0].name}` : ""}`,
        ref: finalNumber,
        debit: t.total,
        userId: req.user!.id,
      });

      // optional "payment received now" recorded with the invoice.
      // If it exceeds this invoice's total, the surplus is applied to the
      // client's oldest unpaid invoices (FIFO) — settling old dues.
      const payAmount = Number(req.body.payment?.amount ?? 0);
      let payInfo: { amount_paid: number; payment_status: string; balance: number } | null = null;
      if (payAmount > 0) {
        const paidOn =
          (req.body.payment?.paid_on as string) || invoice_date || new Date().toISOString().slice(0, 10);
        const mode = ["cash", "upi", "bank", "cheque", "card", "other"].includes(
          req.body.payment?.mode
        )
          ? req.body.payment.mode
          : "cash";
        const reference = (req.body.payment?.reference || "").trim().slice(0, 120) || null;
        let bankId =
          mode === "cash"
            ? null
            : req.body.payment?.bank_account_id
            ? Number(req.body.payment.bank_account_id)
            : null;
        if (bankId) {
          const ba = await tx.query<any>(
            "SELECT company_id FROM bank_accounts WHERE id = ?",
            [bankId]
          );
          if (!ba[0] || Number(ba[0].company_id) !== Number(company_id)) bankId = null;
        }

        // 1. this invoice first
        const onThis = round2(Math.min(payAmount, t.total));
        await tx.exec(
          "INSERT INTO invoice_payments (invoice_id, bank_account_id, paid_on, amount, mode, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [header.insertId, bankId, paidOn, onThis, mode, reference, req.user!.id]
        );
        payInfo = await recomputeInvoicePayment(tx, header.insertId);

        // 2. surplus → oldest unpaid invoices for this client
        let surplus = round2(payAmount - onThis);
        if (surplus > 0.009) {
          const dues = await tx.query<any>(
            `SELECT id, (total - amount_paid) AS due
               FROM invoices
              WHERE client_id = ? AND id <> ? AND (total - amount_paid) > 0.009
              ORDER BY invoice_date ASC, id ASC`,
            [client_id, header.insertId]
          );
          for (const d of dues) {
            if (surplus <= 0.009) break;
            const apply = round2(Math.min(surplus, Number(d.due)));
            await tx.exec(
              "INSERT INTO invoice_payments (invoice_id, bank_account_id, paid_on, amount, mode, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [d.id, bankId, paidOn, apply, mode, reference, req.user!.id]
            );
            await recomputeInvoicePayment(tx, d.id);
            surplus = round2(surplus - apply);
          }
        }

        // LEDGER: whole payment recorded at once — customer owes us less
        const applied = round2(payAmount - surplus);
        if (applied > 0.009) {
          const ML: Record<string, string> = {
            cash: "Cash",
            upi: "UPI",
            bank: "Bank Transfer",
            cheque: "Cheque",
            card: "Card",
            other: "Other",
          };
          const sfx = [ML[mode], reference].filter(Boolean).join(" · ");
          await postEntry(tx, {
            partyType: "client",
            partyId: Number(client_id),
            companyId: Number(company_id),
            date: paidOn,
            sourceType: "payment",
            sourceId: header.insertId,
            particulars: `Payment with ${finalNumber}${sfx ? ` — ${sfx}` : ""}`,
            ref: finalNumber,
            credit: applied,
            userId: req.user!.id,
          });
        }
      }

      // ---- optional linked SALES RETURN on the same document ----
      const rawReturn = Array.isArray(req.body.return_items) ? req.body.return_items : [];
      const retItems = rawReturn
        .map((it: any) => ({
          product_id: it.product_id ? Number(it.product_id) : null,
          description: (it.description || "").trim(),
          hsn: (it.hsn || "").trim() || null,
          qty: Number(it.qty ?? 0),
          rate: Number(it.rate ?? 0),
          gst_rate: Number(it.gst_rate ?? 0),
        }))
        .filter((it: any) => it.description && it.qty > 0);
      let returnInfo: { id: number; number: string; total: number } | null = null;
      if (retItems.length > 0) {
        const reason = ["damaged", "wrong_item", "excess", "not_needed", "other"].includes(
          req.body.return_reason
        )
          ? req.body.return_reason
          : "other";
        const restock = reason === "damaged" ? 0 : 1;
        const rt = computeTotals(retItems, 0, true);
        await tx.exec(
          `INSERT INTO invoice_counters (company_id, year, seq) VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE seq = seq + 1`,
          [company_id, year]
        );
        const [rctr] = await tx.query<any>(
          "SELECT seq FROM invoice_counters WHERE company_id = ? AND year = ?",
          [company_id, year]
        );
        const rNumber = formatInvoiceNumber("SRET", "SRET", year, rctr.seq);
        const rHead = await tx.exec(
          `INSERT INTO sales_returns
             (client_id, company_id, invoice_id, number, return_date, reason, restock,
              subtotal, tax_total, total, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            client_id,
            company_id,
            header.insertId,
            rNumber,
            invoice_date,
            reason,
            restock,
            rt.subtotal,
            rt.tax_total,
            rt.total,
            (req.body.return_notes || "").trim() || null,
            req.user!.id,
          ]
        );
        const rid = rHead.insertId!;
        for (const it of rt.items) {
          await tx.exec(
            `INSERT INTO sales_return_items
               (sales_return_id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [rid, it.product_id, it.description, it.hsn, it.qty, it.rate, it.amount, it.gst_rate, it.tax_amount]
          );
        }
        if (restock) {
          await applyStockForDocument(tx, {
            lines: rt.items.map((it) => ({ product_id: it.product_id, qty: it.qty })),
            direction: +1,
            refType: "sales_return",
            refId: rid,
            userId: req.user!.id,
            note: `Return with ${finalNumber}`,
          });
        }
        await postEntry(tx, {
          partyType: "client",
          partyId: Number(client_id),
          companyId: Number(company_id),
          date: invoice_date,
          sourceType: "sales_return",
          sourceId: rid,
          particulars: `Sales Return with ${finalNumber} (${reason.replace("_", " ")})`,
          ref: rNumber,
          credit: rt.total,
          userId: req.user!.id,
        });
        returnInfo = { id: rid, number: rNumber, total: rt.total };
      }

      const client_balance = await partyBalance("client", Number(client_id), { runner: tx });

      return {
        id: header.insertId,
        number: finalNumber,
        total: t.total,
        amount_paid: payInfo?.amount_paid ?? 0,
        payment_status: payInfo?.payment_status ?? "unpaid",
        balance: payInfo?.balance ?? t.total,
        client_balance,
        linked_return: returnInfo,
      };
    });

    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

// ---- update ----

router.put("/:id", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const existing = await query<any>("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
    if (!existing[0]) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const { company_id, client_id, invoice_date, due_date, number, notes } = req.body;
    const discount = Number(req.body.discount ?? 0);
    const discountIsPct = req.body.discount_is_pct !== false && req.body.discount_is_pct !== 0;
    const items = parseItems(req.body);

    if (!company_id || !client_id || !invoice_date) {
      res.status(400).json({ error: "Company, client and date are required" });
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
        `UPDATE invoices SET
           company_id = ?, client_id = ?, invoice_date = ?, due_date = ?, number = ?, notes = ?,
           subtotal = ?, discount = ?, discount_is_pct = ?, discount_value = ?,
           tax_total = ?, total = ?, payment_status = ?
         WHERE id = ?`,
        [
          company_id,
          client_id,
          invoice_date,
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
      await tx.exec("DELETE FROM invoice_items WHERE invoice_id = ?", [req.params.id]);
      for (const it of t.items) {
        await tx.exec(
          `INSERT INTO invoice_items
             (invoice_id, product_id, description, hsn, qty, rate, amount, gst_rate, tax_amount)
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
      // re-diff stock
      await reverseStockForDocument(tx, "invoice", Number(req.params.id));
      await applyStockForDocument(tx, {
        lines: t.items.map((it) => ({ product_id: it.product_id, qty: it.qty })),
        direction: -1,
        refType: "invoice",
        refId: Number(req.params.id),
        userId: req.user!.id,
        note: `Invoice ${(number || "").trim() || existing[0].number}`,
      });

      // LEDGER: keep the sale entry in sync with the (possibly new) total
      await voidEntriesFor(tx, "invoice", Number(req.params.id));
      const coRow = await tx.query<any>("SELECT name FROM companies WHERE id = ?", [company_id]);
      await postEntry(tx, {
        partyType: "client",
        partyId: Number(client_id),
        companyId: Number(company_id),
        date: String(existing[0].invoice_date).slice(0, 10),
        sourceType: "invoice",
        sourceId: Number(req.params.id),
        particulars: `Sales Invoice${coRow[0]?.name ? ` — ${coRow[0].name}` : ""}`,
        ref: (number || "").trim() || existing[0].number,
        debit: t.total,
        userId: req.user!.id,
      });
    });

    res.json({ id: Number(req.params.id), total: t.total, payment_status: status });
  } catch (err) {
    next(err);
  }
});

// ---- payments (history table; amount_paid + payment_status derive from these) ----

router.get("/:id/payments", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT ip.id, ip.paid_on, ip.amount, ip.bank_account_id,
              ba.name AS bank_name, ba.last4 AS bank_last4
       FROM invoice_payments ip
       LEFT JOIN bank_accounts ba ON ba.id = ip.bank_account_id
       WHERE ip.invoice_id = ?
       ORDER BY ip.paid_on, ip.id`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/payment", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const inv = await query<any>(
      "SELECT id, company_id, total, amount_paid FROM invoices WHERE id = ?",
      [req.params.id]
    );
    if (!inv[0]) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }

    // back-compat: old callers sent { add } or { amount_paid } with no paid_on.
    let amount: number;
    if (req.body.amount != null) {
      amount = Number(req.body.amount);
    } else if (req.body.add != null) {
      amount = Number(req.body.add);
    } else if (req.body.amount_paid != null) {
      amount = Number(req.body.amount_paid) - Number(inv[0].amount_paid || 0);
    } else {
      res.status(400).json({ error: "Provide an amount" });
      return;
    }
    if (!(amount > 0)) {
      res.status(400).json({ error: "Amount must be greater than zero" });
      return;
    }
    amount = Math.round((amount + Number.EPSILON) * 100) / 100;

    const paidOn = (req.body.paid_on as string) || new Date().toISOString().slice(0, 10);
    const payMode = ["cash", "upi", "bank", "cheque", "card", "other"].includes(req.body.mode)
      ? req.body.mode
      : "cash";
    const payRef = (req.body.reference || "").trim().slice(0, 120) || null;
    const bankAccountId =
      payMode === "cash"
        ? null
        : req.body.bank_account_id
        ? Number(req.body.bank_account_id)
        : null;

    if (bankAccountId) {
      const ba = await query<any>(
        "SELECT company_id FROM bank_accounts WHERE id = ?",
        [bankAccountId]
      );
      if (!ba[0]) {
        res.status(400).json({ error: "Bank account not found" });
        return;
      }
      if (Number(ba[0].company_id) !== Number(inv[0].company_id)) {
        res.status(400).json({ error: "That bank account is not for this invoice's company" });
        return;
      }
    }

    const result = await withTransaction(async (tx) => {
      const ins = await tx.exec(
        "INSERT INTO invoice_payments (invoice_id, bank_account_id, paid_on, amount, mode, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [req.params.id, bankAccountId, paidOn, amount, payMode, payRef, req.user!.id]
      );
      const [clRow] = await tx.query<any>(
        "SELECT client_id, company_id, number FROM invoices WHERE id = ?",
        [req.params.id]
      );
      if (clRow?.client_id) {
        const ML: Record<string, string> = {
          cash: "Cash", upi: "UPI", bank: "Bank Transfer", cheque: "Cheque", card: "Card", other: "Other",
        };
        const sfx = [ML[payMode], payRef].filter(Boolean).join(" · ");
        await postEntry(tx, {
          partyType: "client",
          partyId: Number(clRow.client_id),
          companyId: clRow.company_id ? Number(clRow.company_id) : null,
          date: paidOn,
          sourceType: "payment",
          sourceId: ins.insertId!, // = invoice_payments.id
          particulars: `Payment against ${clRow.number || `#${req.params.id}`}${sfx ? ` — ${sfx}` : ""}`,
          ref: clRow.number || null,
          credit: amount,
          userId: req.user!.id,
        });
      }
      return recomputeInvoicePayment(tx, Number(req.params.id));
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
        "DELETE FROM invoice_payments WHERE id = ? AND invoice_id = ?",
        [req.params.paymentId, req.params.id]
      );
      if (del.affectedRows === 0) return null;
      // remove the matching ledger credit (posted with source_id = invoice_payments.id)
      await tx.exec(
        "DELETE FROM ledger_entries WHERE source_type = 'payment' AND source_id = ?",
        [req.params.paymentId]
      );
      return recomputeInvoicePayment(tx, Number(req.params.id));
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
    const id = Number(req.params.id);
    await withTransaction(async (tx) => {
      await reverseStockForDocument(tx, "invoice", id); // add stock back
      await voidEntriesFor(tx, "invoice", id);
      await voidEntriesFor(tx, "payment", id); // "paid now" credit
      await tx.exec("DELETE FROM invoices WHERE id = ?", [id]); // items + payments cascade
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- A4 PDF (auth via ?token= so a browser download link works) ----

router.get("/:id/pdf", requireAdmin, async (req, res, next) => {
  try {
    const { buffer, filename } = await renderInvoicePdf(req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    res.send(buffer);
  } catch (err: any) {
    if (err?.code === "INVOICE_NOT_FOUND") {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    next(err);
  }
});

export default router;
