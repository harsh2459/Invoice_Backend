import { Router } from "express";
import { query, exec, withTransaction } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import { refreshClientRoster } from "../whatsapp";
import { recomputeInvoicePayment, round2, formatInvoiceNumber } from "../invoiceMath";
import { renderReceiptPdf } from "../receiptPdf";
import { loadInvoiceForPdf, drawInvoicePage } from "../invoicePdf";
import { postEntry, voidEntriesFor, partyBalance, partyStatement } from "../ledger";

const MODE_LABEL: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  bank: "Bank Transfer",
  cheque: "Cheque",
  card: "Card",
  other: "Other",
};
import {
  newDoc,
  collect,
  masthead,
  twoColBlock,
  band,
  box,
  vline,
  rule,
  pageBorder,
  INR as LINR,
  ddmmyyyy as LDATE,
  BAND_TEXT,
  INK,
} from "../pdfLavender";

/** Rebuild the WhatsApp inbox roster for every company this client is linked to. */
async function refreshRostersForClient(clientId: number | string | string[]) {
  const rows = await query<{ company_id: number }>(
    "SELECT company_id FROM company_clients WHERE client_id = ?",
    [String(clientId)]
  );
  for (const r of rows) void refreshClientRoster(Number(r.company_id)).catch(() => {});
}

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT c.id, c.name, c.address, c.phone, c.email, c.gstin,
              (SELECT COUNT(*) FROM company_clients cc WHERE cc.client_id = c.id) AS company_count
       FROM clients c
       ORDER BY c.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query<any>(
      "SELECT id, name, address, phone, email, gstin FROM clients WHERE id = ?",
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const companies = await query(
      `SELECT co.id, co.name FROM companies co
       JOIN company_clients cc ON cc.company_id = co.id
       WHERE cc.client_id = ?
       ORDER BY co.name`,
      [req.params.id]
    );
    res.json({ ...rows[0], companies });
  } catch (err) {
    next(err);
  }
});

// Full activity view for one client: KPIs, every invoice, products bought.
router.get("/:id/summary", async (req, res, next) => {
  try {
    const cid = req.params.id;
    const base = await query<any>(
      "SELECT id, name, address, phone, email, gstin FROM clients WHERE id = ?",
      [cid]
    );
    if (!base[0]) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const invoices = await query<any>(
      `SELECT i.id, i.number, i.invoice_date, i.due_date, i.total, i.amount_paid,
              (i.total - i.amount_paid) AS balance, i.payment_status,
              co.name AS company_name
         FROM invoices i
         LEFT JOIN companies co ON co.id = i.company_id
        WHERE i.client_id = ?
        ORDER BY i.invoice_date DESC, i.id DESC`,
      [cid]
    );

    const [agg] = await query<any>(
      `SELECT COUNT(*) AS invoice_count,
              COALESCE(SUM(total), 0) AS total_invoiced,
              COALESCE(SUM(amount_paid), 0) AS total_paid,
              COALESCE(SUM(total - amount_paid), 0) AS outstanding,
              COALESCE(SUM(CASE WHEN (total - amount_paid) > 0.009 THEN 1 ELSE 0 END), 0) AS unpaid_count,
              MIN(invoice_date) AS first_invoice,
              MAX(invoice_date) AS last_invoice
         FROM invoices WHERE client_id = ?`,
      [cid]
    );

    const products = await query<any>(
      `SELECT ii.description,
              SUM(ii.qty) AS qty,
              SUM(ii.amount) AS value,
              COUNT(DISTINCT ii.invoice_id) AS invoice_count,
              MAX(i.invoice_date) AS last_bought
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.client_id = ?
        GROUP BY ii.description
        ORDER BY value DESC`,
      [cid]
    );

    // outstanding = true ledger balance (includes on-account receipts + returns)
    const outstanding = await partyBalance("client", Number(cid));

    res.json({
      client: base[0],
      kpis: {
        invoice_count: Number(agg?.invoice_count || 0),
        total_invoiced: Number(agg?.total_invoiced || 0),
        total_paid: Number(agg?.total_paid || 0),
        outstanding,
        unpaid_count: Number(agg?.unpaid_count || 0),
        first_invoice: agg?.first_invoice ?? null,
        last_invoice: agg?.last_invoice ?? null,
      },
      invoices,
      products,
    });
  } catch (err) {
    next(err);
  }
});

// ---- on-account receipts (money in, not tied to one bill at entry) ----

router.get("/:id/receipts", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT r.id, r.number, r.receipt_date, r.amount, r.unapplied, r.notes,
              r.mode, r.reference, r.bank_account_id, ba.name AS bank_name, ba.last4 AS bank_last4,
              co.name AS company_name
         FROM client_receipts r
         LEFT JOIN bank_accounts ba ON ba.id = r.bank_account_id
         LEFT JOIN companies co ON co.id = r.company_id
        WHERE r.client_id = ?
        ORDER BY r.receipt_date DESC, r.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/receipts", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const clientId = Number(req.params.id);
    const amount = round2(Number(req.body.amount));
    if (!(amount > 0)) {
      res.status(400).json({ error: "Amount must be greater than zero" });
      return;
    }
    const receiptDate = new Date().toISOString().slice(0, 10);
    const notes = (req.body.notes || "").trim() || null;
    const mode = ["cash", "upi", "bank", "cheque", "card", "other"].includes(req.body.mode)
      ? req.body.mode
      : "cash";
    const reference = (req.body.reference || "").trim().slice(0, 120) || null;
    let bankId = req.body.bank_account_id ? Number(req.body.bank_account_id) : null;
    if (mode === "cash") bankId = null; // cash never carries a bank

    const client = await query<any>("SELECT id, name FROM clients WHERE id = ?", [clientId]);
    if (!client[0]) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    // Which company does this receipt belong to? Prefer an explicit one, else
    // the company of the oldest unpaid invoice, else the client's first link.
    let companyId: number | null = req.body.company_id ? Number(req.body.company_id) : null;
    if (bankId) {
      const ba = await query<any>("SELECT company_id FROM bank_accounts WHERE id = ?", [bankId]);
      if (!ba[0]) bankId = null;
      else companyId = companyId ?? Number(ba[0].company_id);
    }

    const result = await withTransaction(async (tx) => {
      const dues = await tx.query<any>(
        `SELECT id, company_id, (total - amount_paid) AS due
           FROM invoices
          WHERE client_id = ? AND (total - amount_paid) > 0.009
          ORDER BY invoice_date ASC, id ASC`,
        [clientId]
      );
      if (!companyId) companyId = dues[0]?.company_id ?? null;
      if (!companyId) {
        const link = await tx.query<any>(
          "SELECT company_id FROM company_clients WHERE client_id = ? ORDER BY company_id LIMIT 1",
          [clientId]
        );
        companyId = link[0]?.company_id ?? null;
      }

      // receipt number (per-company sequence, RCPT prefix)
      const year = new Date().getFullYear();
      let number = `RCPT-${year}-00001`;
      if (companyId) {
        await tx.exec(
          `INSERT INTO invoice_counters (company_id, year, seq) VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE seq = seq + 1`,
          [companyId, year]
        );
        const ctr = await tx.query<any>(
          "SELECT seq FROM invoice_counters WHERE company_id = ? AND year = ?",
          [companyId, year]
        );
        number = formatInvoiceNumber("RCPT", "RCPT", year, ctr[0].seq);
      }

      const rec = await tx.exec(
        `INSERT INTO client_receipts
           (client_id, company_id, number, receipt_date, amount, unapplied, bank_account_id, mode, reference, notes, created_by)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        [clientId, companyId, number, receiptDate, amount, bankId, mode, reference, notes, req.user!.id]
      );
      const receiptId = rec.insertId!;

      // FIFO-apply to oldest unpaid invoices
      let left = amount;
      const applied: { invoice_id: number; amount: number }[] = [];
      for (const d of dues) {
        if (left <= 0.009) break;
        const slice = round2(Math.min(left, Number(d.due)));
        await tx.exec(
          `INSERT INTO invoice_payments (invoice_id, bank_account_id, paid_on, amount, receipt_id, mode, reference, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [d.id, bankId, receiptDate, slice, receiptId, mode, reference, req.user!.id]
        );
        await recomputeInvoicePayment(tx, d.id);
        applied.push({ invoice_id: d.id, amount: slice });
        left = round2(left - slice);
      }
      if (left > 0.009) {
        await tx.exec("UPDATE client_receipts SET unapplied = ? WHERE id = ?", [left, receiptId]);
      }

      // LEDGER: the whole receipt is one credit — customer owes us less
      const modeLabel = MODE_LABEL[mode] || mode;
      const partsuffix = [modeLabel, reference, notes].filter(Boolean).join(" · ");
      await postEntry(tx, {
        partyType: "client",
        partyId: clientId,
        companyId,
        date: receiptDate,
        sourceType: "receipt",
        sourceId: receiptId,
        particulars: `Payment Received${partsuffix ? ` — ${partsuffix}` : ""}`,
        ref: number,
        credit: amount,
        userId: req.user!.id,
      });

      const client_balance = await partyBalance("client", clientId, { runner: tx });

      return { id: receiptId, number, amount, applied, unapplied: round2(left), client_balance };
    });

    void refreshRostersForClient(clientId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---- statement / ledger: reads ledger_entries only ----

async function buildStatement(clientId: string, from: string, to: string) {
  const client = await query<any>(
    "SELECT id, name, address, phone, email, gstin FROM clients WHERE id = ?",
    [clientId]
  );
  const s = await partyStatement("client", Number(clientId), { from, to });
  return {
    client: client[0] || null,
    opening_balance: s.opening_balance,
    closing_balance: s.closing_balance,
    rows: s.rows, // already carry kind_label + children
    totals: s.totals,
    from,
    to,
  };
}

router.get("/:id/statement", async (req, res, next) => {
  try {
    const s = await buildStatement(
      req.params.id,
      (req.query.from as string) || "",
      (req.query.to as string) || ""
    );
    res.json(s);
  } catch (err) {
    next(err);
  }
});

// Statement as a passbook-style PDF.
router.get("/:id/statement/pdf", async (req, res, next) => {
  try {
    const s = await buildStatement(
      req.params.id,
      (req.query.from as string) || "",
      (req.query.to as string) || ""
    );
    if (!s.client) {
      res.status(404).send("Client not found");
      return;
    }
    // company for the masthead = the one on the client's most recent invoice
    const [co] = await query<any>(
      `SELECT co.name, co.phone, co.email, co.gstin, co.logo
         FROM invoices i JOIN companies co ON co.id = i.company_id
        WHERE i.client_id = ? ORDER BY i.invoice_date DESC, i.id DESC LIMIT 1`,
      [req.params.id]
    );

    const d = newDoc();
    const { doc, left, right, contentW } = d;
    const done = collect(doc);

    let y = left;
    y = masthead(d, co || {}, "Account Statement", y);
    y = twoColBlock(
      d,
      y,
      "Statement For",
      "Period",
      [
        s.client.name || "—",
        s.client.phone ? `Contact No. : ${s.client.phone}` : "",
        s.client.address || "",
      ].filter(Boolean),
      [
        s.from ? `From : ${LDATE(s.from)}` : "From : beginning",
        s.to ? `To : ${LDATE(s.to)}` : `To : ${LDATE(new Date().toISOString())}`,
        `Opening : ${LINR(s.opening_balance)}`,
      ]
    );

    // plain-language legend so "Billed / Received" is unambiguous
    doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#5b616b").text(
      "Billed (+) = invoices raised on the client.   Received / Returned (-) = payments received and credit notes.",
      left,
      y
    );
    y += 12;

    // table header — columns sized so nothing overlaps
    const headH = 26;
    band(d, y, headH);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(BAND_TEXT);
    const wDate = 54,
      wRef = 108,
      wNum = 94; // billed / received / balance each
    const cDate = left;
    const cPart = cDate + wDate;
    const cBal = right - wNum;
    const cCr = cBal - wNum;
    const cDr = cCr - wNum;
    const cRef = cDr - wRef;
    const cell = (txt: string, x: number, w: number, align: "left" | "right" = "left") =>
      doc.text(txt, x + 4, y + 4, { width: w - 8, align });
    cell("Date", cDate, wDate);
    cell("Particulars", cPart, cRef - cPart);
    cell("Ref", cRef, wRef);
    cell("Billed (+)", cDr, wNum, "right");
    cell("Received /\nReturned (-)", cCr, wNum, "right");
    cell("Balance", cBal, wNum, "right");
    y += headH;
    const tableTop = y;

    const rowCell = (txt: string, x: number, w: number, align: "left" | "right" = "left") =>
      doc.text(txt, x + 4, y + 4, { width: w - 8, align });

    // opening row
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#5b616b");
    rowCell("Opening Balance", cPart, cRef - cPart);
    rowCell(LINR(s.opening_balance), cBal, wNum, "right");
    y += 15;
    rule(d, y);

    for (const r of s.rows) {
      if (y > d.pageBottom - 60) {
        doc.addPage();
        y = left;
      }
      doc.font("Helvetica").fontSize(8.5).fillColor(INK);
      rowCell(LDATE(r.date), cDate, wDate);
      // short, clear type word (no company suffix, no truncation) — ref shows the number
      const kids = (r as any).children as any[] | undefined;
      const label =
        (r as any).kind_label ||
        (r as any).particulars ||
        "";
      const withKids =
        kids && kids.length
          ? `${label}  (incl. ${kids.map((k) => k.kind_label || k.particulars).join(" + ")})`
          : label;
      doc.text(withKids, cPart + 4, y + 4, {
        width: cRef - cPart - 8,
      });
      rowCell(r.ref, cRef, wRef);
      rowCell(r.debit ? LINR(r.debit) : "", cDr, wNum, "right");
      rowCell(r.credit ? LINR(r.credit) : "", cCr, wNum, "right");
      rowCell(LINR(r.balance), cBal, wNum, "right");
      const nameH = doc.heightOfString(withKids, { width: cRef - cPart - 8 });
      y += Math.max(16, nameH + 6);
      rule(d, y);

      // nested sub-lines for a combined document (bill + payment + return)
      if (kids && kids.length) {
        doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#5b616b");
        for (const k of kids) {
          if (y > d.pageBottom - 60) {
            doc.addPage();
            y = left;
          }
          doc.text(`   ${LDATE(k.date)}`, cDate + 4, y + 3, { width: wDate - 8 });
          doc.text(`      ${k.kind_label || k.particulars}`, cPart + 4, y + 3, {
            width: cRef - cPart - 8,
          });
          doc.text(k.ref || "", cRef + 4, y + 3, { width: wRef - 8 });
          doc.text(k.debit ? LINR(k.debit) : "", cDr + 4, y + 3, { width: wNum - 8, align: "right" });
          doc.text(k.credit ? LINR(k.credit) : "", cCr + 4, y + 3, {
            width: wNum - 8,
            align: "right",
          });
          y += 13;
          rule(d, y);
        }
      }
    }

    // totals row
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK);
    rowCell("Total", cPart, cRef - cPart);
    rowCell(LINR(s.totals.debit), cDr, wNum, "right");
    rowCell(LINR(s.totals.credit), cCr, wNum, "right");
    rowCell(LINR(s.closing_balance), cBal, wNum, "right");
    y += 18;

    [cDate, cPart, cRef, cDr, cCr, cBal, right].forEach((x) => vline(d, x, tableTop, y));
    doc.moveTo(left, tableTop).lineTo(right, tableTop).lineWidth(0.8).strokeColor("#8C86D9").stroke();
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor("#8C86D9").stroke();

    // closing balance band
    y += 6;
    band(d, y);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT).text("Summary", left + 6, y + 4);
    y += 15;
    box(d, y, 22);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK);
    doc.text("Closing Balance (amount due)", left + 6, y + 6);
    doc.text(LINR(s.closing_balance), left + 6, y + 6, { width: contentW - 12, align: "right" });
    y += 22;

    pageBorder(d, y);

    // ---- append every invoice from this statement, one per page ----
    const invIds: number[] = [];
    for (const r of s.rows) {
      if (r.source_type === "invoice" && r.source_id) invIds.push(Number(r.source_id));
    }
    for (const invId of invIds) {
      const data = await loadInvoiceForPdf(invId);
      if (!data) continue;
      drawInvoicePage(doc, data.inv, data.co, data.items, data.prevBalance, data.extra);
    }

    doc.end();

    const buffer = await done;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="Statement_${(s.client.name || s.client.id).replace(/[^\w-]/g, "_")}.pdf"`
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Receipt PDF.
router.delete("/:id/receipts/:rid", requireAdmin, async (req, res, next) => {
  try {
    const rid = Number(req.params.rid);
    const ok = await withTransaction(async (tx) => {
      const [r] = await tx.query<any>(
        "SELECT id, client_id FROM client_receipts WHERE id = ? AND client_id = ?",
        [rid, req.params.id]
      );
      if (!r) return false;
      // reverse the FIFO payments this receipt made, then recompute those invoices
      const pays = await tx.query<any>(
        "SELECT id, invoice_id FROM invoice_payments WHERE receipt_id = ?",
        [rid]
      );
      await tx.exec("DELETE FROM invoice_payments WHERE receipt_id = ?", [rid]);
      for (const p of pays) await recomputeInvoicePayment(tx, Number(p.invoice_id));
      await voidEntriesFor(tx, "receipt", rid);
      await tx.exec("DELETE FROM client_receipts WHERE id = ?", [rid]);
      return true;
    });
    if (!ok) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }
    res.json({
      ok: true,
      client_balance: await partyBalance("client", Number(req.params.id)),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/receipts/:rid", async (req, res, next) => {
  try {
    const [r] = await query<any>(
      `SELECT cr.*, cl.name AS client_name, cl.phone AS client_phone, cl.address AS client_address,
              cl.gstin AS client_gstin, cl.email AS client_email,
              co.name AS company_name, ba.name AS bank_name, ba.last4 AS bank_last4
         FROM client_receipts cr
         LEFT JOIN clients cl ON cl.id = cr.client_id
         LEFT JOIN companies co ON co.id = cr.company_id
         LEFT JOIN bank_accounts ba ON ba.id = cr.bank_account_id
        WHERE cr.id = ? AND cr.client_id = ?`,
      [req.params.rid, req.params.id]
    );
    if (!r) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }
    const allocations = await query<any>(
      `SELECT ip.amount, i.id AS invoice_id, i.number AS invoice_number, i.invoice_date,
              (i.total - i.amount_paid) AS balance_after
         FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
        WHERE ip.receipt_id = ?
        ORDER BY i.invoice_date, i.id`,
      [req.params.rid]
    );
    const current_balance = await partyBalance("client", Number(req.params.id));
    const applied = round2(Number(r.amount) - Number(r.unapplied || 0));
    res.json({
      ...r,
      allocations,
      client_balance: current_balance,
      current_balance,
      previous_balance: round2(current_balance + applied),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/receipts/:rid/pdf", async (req, res, next) => {
  try {
    const { buffer, filename } = await renderReceiptPdf(req.params.rid);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.send(buffer);
  } catch (err: any) {
    if (err?.code === "RECEIPT_NOT_FOUND") {
      res.status(404).send("Receipt not found");
      return;
    }
    next(err);
  }
});

router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    const { address, phone, email, gstin } = req.body;
    const result = await exec(
      "INSERT INTO clients (name, address, phone, email, gstin) VALUES (?, ?, ?, ?, ?)",
      [name, address || null, phone || null, email || null, gstin || null]
    );
    res.json({ id: result.insertId, name, address, phone, email, gstin });
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    const { address, phone, email, gstin } = req.body;
    const result = await exec(
      "UPDATE clients SET name = ?, address = ?, phone = ?, email = ?, gstin = ? WHERE id = ?",
      [name, address || null, phone || null, email || null, gstin || null, req.params.id]
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    void refreshRostersForClient(req.params.id); // phone may have changed
    res.json({ id: Number(req.params.id), name, address, phone, email, gstin });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const used = await query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM invoices WHERE client_id = ?",
      [req.params.id]
    );
    if ((used[0]?.c ?? 0) > 0) {
      res.status(409).json({
        error: `This client is on ${used[0]!.c} invoice${used[0]!.c === 1 ? "" : "s"} and can't be deleted.`,
      });
      return;
    }
    await exec("DELETE FROM clients WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- company links (many-to-many, managed from the client side) ----

router.post("/:id/companies", requireAdmin, async (req, res, next) => {
  try {
    const companyId = Number(req.body.company_id);
    if (!companyId) {
      res.status(400).json({ error: "company_id is required" });
      return;
    }
    try {
      await exec(
        "INSERT INTO company_clients (company_id, client_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE client_id = client_id",
        [companyId, req.params.id]
      );
      void refreshClientRoster(companyId).catch(() => {});
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.code === "ER_NO_REFERENCED_ROW_2") {
        res.status(400).json({ error: "That company or client does not exist" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/companies/:companyId", requireAdmin, async (req, res, next) => {
  try {
    await exec("DELETE FROM company_clients WHERE client_id = ? AND company_id = ?", [
      req.params.id,
      req.params.companyId,
    ]);
    void refreshClientRoster(Number(req.params.companyId)).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
