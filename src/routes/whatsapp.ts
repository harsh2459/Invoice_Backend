/**
 * Per-company WhatsApp for the invoicing module. Admin-only.
 *
 * Connection & inbox are scoped by :companyId:
 *   GET  /api/whatsapp/sessions                 all companies + WA status
 *   GET  /api/whatsapp/:companyId/status        one company's state + QR
 *   POST /api/whatsapp/:companyId/connect       start / re-init
 *   POST /api/whatsapp/:companyId/reconnect     force reconnect
 *   POST /api/whatsapp/:companyId/logout        unpair, wipe, new QR
 *   POST /api/whatsapp/:companyId/check         { phone } -> { onWhatsApp, jid }
 *   GET  /api/whatsapp/:companyId/chats
 *   GET  /api/whatsapp/:companyId/chats/:jid/messages
 *   POST /api/whatsapp/:companyId/chats/:jid/send
 *   POST /api/whatsapp/:companyId/chats/:jid/read
 *   POST /api/whatsapp/:companyId/chats/:jid/pic
 *   GET  /api/whatsapp/:companyId/media/:msgKey
 *
 * Templates are global (shared across companies):
 *   GET/PUT /api/whatsapp/templates
 *
 * Invoice sends derive the company from the invoice itself:
 *   POST /api/whatsapp/send/invoice/:id
 *   POST /api/whatsapp/send/reminder/:id
 *   POST /api/whatsapp/send/text/:id
 *   GET  /api/whatsapp/log            /  /api/whatsapp/log/:invoiceId
 */
import path from "path";
import fs from "fs";
import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import { renderInvoicePdf } from "../invoicePdf";
import { previousClientBalance } from "../invoiceMath";
import { publicInvoiceUrl } from "./publicInvoice";
import {
  getState,
  connect,
  reconnect,
  logout,
  checkNumber,
  sendText,
  sendPdf,
  sendChatText,
  sendChatMedia,
  markRead,
  fetchProfilePic,
  ensureMedia,
  allStates,
  refreshClientRoster,
} from "../whatsapp";
import { listChats, listMessages, markChatRead, mediaDirFor } from "../waStore";

const router = Router();
router.use(authenticate, requireAdmin);

// ---- message templates (global) --------------------------------------

export interface WaTemplates {
  invoice: string;
  reminder: string;
  thankyou: string;
}

const DEFAULT_TEMPLATES: WaTemplates = {
  invoice:
    "Greetings from {{company_name}}\n" +
    "We are pleased to have you as a valuable customer. Please find the details of your transaction.\n\n" +
    "Sale Invoice : {{invoice_number}}\n" +
    "Date: {{invoice_date}}\n" +
    "Items: {{item_count}}  |  Total Qty: {{total_qty}}\n" +
    "Invoice Amount: {{total}}\n" +
    "{{gst_line}}" +
    "Received: {{amount_paid}}\n" +
    "{{previous_balance_line}}" +
    "Balance: {{balance}}\n" +
    "{{current_balance_line}}\n" +
    "Thanks for doing business with us.\n" +
    "Regards,\n{{company_name}}\n\n" +
    "Invoice Link:\n{{invoice_link}}",
  reminder:
    "Greetings from {{company_name}}\n\n" +
    "Gentle reminder for invoice {{invoice_number}} dated {{invoice_date}}.\n\n" +
    "Invoice Amount: {{total}}\n" +
    "Received: {{amount_paid}}\n" +
    "{{previous_balance_line}}" +
    "Balance Due: {{balance}}\n" +
    "{{current_balance_line}}\n" +
    "Please arrange the payment at your earliest convenience.\n\n" +
    "Regards,\n{{company_name}}\n\n" +
    "Invoice Link:\n{{invoice_link}}",
  thankyou:
    "Hi {{client_name}},\n\nWe have received your payment against invoice {{invoice_number}}. Thank you!\n\n{{company_name}}",
};

async function loadTemplates(): Promise<WaTemplates> {
  const rows = await query<{ templates: string }>("SELECT templates FROM wa_settings WHERE id = 1");
  if (!rows[0]?.templates) return { ...DEFAULT_TEMPLATES };
  try {
    return { ...DEFAULT_TEMPLATES, ...JSON.parse(rows[0].templates) };
  } catch {
    return { ...DEFAULT_TEMPLATES };
  }
}

function invoiceVars(
  inv: any,
  extra?: { items?: any[]; previousBalance?: number; invoiceLink?: string }
): Record<string, string> {
  const inr = (n: any) =>
    "Rs. " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const d = (v: any) => {
    const iso = String(v || "").slice(0, 10);
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
  };
  const total = Number(inv.total || 0);
  const paid = Number(inv.amount_paid || 0);
  const balance = Math.round((total - paid) * 100) / 100;
  const items = extra?.items || [];
  const totalQty = items.reduce((s, it) => s + Number(it.qty || 0), 0);
  const itemsTotal = items.reduce((s, it) => s + Number(it.amount || 0), 0);
  const prev = Math.round((extra?.previousBalance || 0) * 100) / 100;
  const current = Math.round((prev + balance) * 100) / 100;
  const gst = Number(inv.tax_total || 0);

  return {
    client_name: inv.client_name || "there",
    company_name: inv.company_name || "us",
    invoice_number: inv.number || `#${inv.id}`,
    invoice_date: d(inv.invoice_date),
    due_date: inv.due_date ? d(inv.due_date) : "",
    due_clause: inv.due_date ? `, due ${d(inv.due_date)}` : "",
    total: inr(total),
    amount_paid: inr(paid),
    balance: inr(balance),
    item_count: String(items.length),
    total_qty: Number.isInteger(totalQty) ? String(totalQty) : totalQty.toFixed(2),
    items_total: inr(itemsTotal),
    gst_line: gst > 0 ? `GST: ${inr(gst)}\n` : "",
    previous_balance: inr(prev),
    previous_balance_line: prev > 0.009 ? `Previous Balance: ${inr(prev)}\n` : "",
    current_balance: inr(current),
    current_balance_line: prev > 0.009 ? `Current Balance (total outstanding): ${inr(current)}\n` : "",
    invoice_link: extra?.invoiceLink || "",
    status:
      inv.payment_status === "paid"
        ? "Paid"
        : inv.payment_status === "partial"
        ? "Partially paid"
        : "Unpaid",
  };
}

const fillTemplate = (tpl: string, vars: Record<string, string>) =>
  tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : ""));

router.get("/templates", async (_req, res, next) => {
  try {
    res.json(await loadTemplates());
  } catch (err) {
    next(err);
  }
});

router.put("/templates", async (req, res, next) => {
  try {
    const incoming = req.body || {};
    const merged: WaTemplates = {
      invoice: String(incoming.invoice ?? DEFAULT_TEMPLATES.invoice),
      reminder: String(incoming.reminder ?? DEFAULT_TEMPLATES.reminder),
      thankyou: String(incoming.thankyou ?? DEFAULT_TEMPLATES.thankyou),
    };
    await exec(
      `INSERT INTO wa_settings (id, templates) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE templates = VALUES(templates)`,
      [JSON.stringify(merged)]
    );
    res.json(merged);
  } catch (err) {
    next(err);
  }
});

// ---- sessions overview (for the company picker) --------------------

router.get("/sessions", async (_req, res, next) => {
  try {
    const companies = await query<{ id: number; name: string }>(
      "SELECT id, name FROM companies ORDER BY name"
    );
    const live = new Map(allStates().map((s) => [s.companyId, s]));
    const rows = await query<any>(
      "SELECT company_id, status, phone_number, display_name, last_connected_at FROM wa_sessions"
    );
    const persisted = new Map(rows.map((r) => [Number(r.company_id), r]));
    res.json(
      companies.map((c) => {
        const l = live.get(c.id);
        const p = persisted.get(c.id);
        return {
          companyId: c.id,
          companyName: c.name,
          status: l?.status ?? p?.status ?? "idle",
          phoneNumber: l?.me?.number ?? p?.phone_number ?? null,
          displayName: l?.me?.name ?? p?.display_name ?? null,
          lastConnectedAt: p?.last_connected_at ?? null,
        };
      })
    );
  } catch (err) {
    next(err);
  }
});

// ---- per-company connection ---------------------------------------

// resolve + validate :companyId once
router.param("companyId", async (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Bad company id" });
    return;
  }
  const rows = await query<{ id: number }>("SELECT id FROM companies WHERE id = ?", [id]);
  if (!rows[0]) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  (req as any).companyId = id;
  next();
});

const cid = (req: any): number => (req as any).companyId as number;

router.get("/:companyId/status", (req, res) => {
  res.json(getState(cid(req)));
});

router.post("/:companyId/connect", async (req, res, next) => {
  try {
    await connect(cid(req));
    res.json(getState(cid(req)));
  } catch (err) {
    next(err);
  }
});

router.post("/:companyId/reconnect", async (req, res, next) => {
  try {
    await reconnect(cid(req));
    res.json(getState(cid(req)));
  } catch (err) {
    next(err);
  }
});

router.post("/:companyId/logout", async (req, res, next) => {
  try {
    await logout(cid(req));
    res.json(getState(cid(req)));
  } catch (err) {
    next(err);
  }
});

router.post("/:companyId/check", async (req, res, next) => {
  try {
    const jid = await checkNumber(cid(req), String(req.body.phone || ""));
    res.json({ onWhatsApp: !!jid, jid });
  } catch (err: any) {
    if (err?.userError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ---- per-company inbox ------------------------------------------

router.get("/:companyId/chats", async (req, res, next) => {
  try {
    // The list IS this company's client roster; limit/offset are ignored.
    res.json(await listChats(cid(req)));
  } catch (err) {
    next(err);
  }
});

// Rebuild the roster on demand (e.g. after bulk client import).
router.post("/:companyId/clients/refresh", async (req, res, next) => {
  try {
    await refreshClientRoster(cid(req));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/:companyId/chats/:jid/messages", async (req, res, next) => {
  try {
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    res.json(await listMessages(cid(req), String(req.params.jid), before, limit));
  } catch (err) {
    next(err);
  }
});

router.post("/:companyId/chats/:jid/read", async (req, res, next) => {
  try {
    await markChatRead(cid(req), String(req.params.jid));
    void markRead(cid(req), String(req.params.jid));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:companyId/chats/:jid/pic", async (req, res, next) => {
  try {
    const url = await fetchProfilePic(cid(req), String(req.params.jid));
    res.json({ picUrl: url });
  } catch (err) {
    next(err);
  }
});

// { text } for text, or { fileBase64, mime, filename, caption } for media.
router.post("/:companyId/chats/:jid/send", async (req, res, next) => {
  try {
    const companyId = cid(req);
    const jid = String(req.params.jid);
    const { text, fileBase64, mime, filename, caption } = req.body || {};
    if (fileBase64 && mime) {
      const buf = Buffer.from(String(fileBase64), "base64");
      const id = await sendChatMedia(
        companyId,
        jid,
        buf,
        String(mime),
        String(filename || "file"),
        caption ? String(caption) : undefined
      );
      res.json({ ok: true, msgId: id });
      return;
    }
    if (typeof text === "string" && text.trim()) {
      const id = await sendChatText(companyId, jid, text);
      res.json({ ok: true, msgId: id });
      return;
    }
    res.status(400).json({ error: "Nothing to send" });
  } catch (err: any) {
    if (err?.code === "WA_NOT_CONNECTED") {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err?.userError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

router.get("/:companyId/media/:msgKey", async (req, res, next) => {
  try {
    const companyId = cid(req);
    const media = await ensureMedia(companyId, String(req.params.msgKey));
    if (!media) {
      res.status(404).json({ error: "Media not available" });
      return;
    }
    const dir = mediaDirFor(companyId);
    const abs = path.join(dir, media.path);
    if (!abs.startsWith(dir) || !fs.existsSync(abs)) {
      res.status(404).json({ error: "Media file missing" });
      return;
    }
    res.setHeader("Content-Type", media.mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    next(err);
  }
});

// ---- invoice sends (company derived from the invoice) ------------

async function loadInvoiceForSend(id: string | string[]) {
  const rows = await query<any>(
    `SELECT i.*, co.name AS company_name, cl.name AS client_name, cl.phone AS client_phone
     FROM invoices i
     LEFT JOIN companies co ON co.id = i.company_id
     LEFT JOIN clients cl ON cl.id = i.client_id
     WHERE i.id = ?`,
    [String(id)]
  );
  const inv = rows[0];
  if (!inv) return null;
  inv.items = await query<any>(
    "SELECT description, qty, rate, amount, gst_rate, tax_amount FROM invoice_items WHERE invoice_id = ? ORDER BY id",
    [String(id)]
  );
  return inv;
}

async function recordSend(opts: {
  companyId: number | null;
  invoiceId: number;
  clientId: number | null;
  phone: string;
  kind: "invoice" | "reminder" | "text";
  body: string;
  status: "sent" | "failed";
  error: string | null;
  wamId: string | null;
  userId: number;
}) {
  await exec(
    `INSERT INTO wa_messages
       (company_id, invoice_id, client_id, phone, kind, body, status, error, wam_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.companyId,
      opts.invoiceId,
      opts.clientId,
      opts.phone,
      opts.kind,
      opts.body,
      opts.status,
      opts.error,
      opts.wamId,
      opts.userId,
    ]
  );
}

async function handleDocumentSend(
  req: AuthRequest,
  res: any,
  next: any,
  kind: "invoice" | "reminder"
) {
  try {
    const inv = await loadInvoiceForSend(req.params.id);
    if (!inv) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    if (!inv.company_id) {
      res.status(400).json({ error: "This invoice has no company — can't pick a WhatsApp number." });
      return;
    }
    if (kind === "reminder" && Number(inv.total) - Number(inv.amount_paid) <= 0.005) {
      res.status(400).json({ error: "This invoice is fully paid — nothing to remind about." });
      return;
    }

    const companyId = Number(inv.company_id);
    const st = getState(companyId);
    if (st.status === "idle" || st.status === "logged_out" || st.status === "qr") {
      res.status(409).json({
        error: `${inv.company_name || "This firm"}'s WhatsApp isn't connected. Pair it in Invoicing → WhatsApp.`,
        code: "WA_NOT_CONNECTED",
      });
      return;
    }

    const phone = String(req.body.phone || inv.client_phone || "").trim();
    if (!phone) {
      res.status(400).json({ error: "No phone number for this client. Add one or pass a number." });
      return;
    }

    const templates = await loadTemplates();
    const origin = `${req.protocol}://${req.get("host")}`;
    const previousBalance = await previousClientBalance(
      { query },
      {
        clientId: inv.client_id,
        invoiceDate: String(inv.invoice_date).slice(0, 10),
        invoiceId: inv.id,
      }
    );
    const vars = invoiceVars(inv, {
      items: inv.items,
      previousBalance,
      invoiceLink: publicInvoiceUrl(inv.id, origin),
    });
    const body =
      typeof req.body.message === "string" && req.body.message.trim()
        ? req.body.message
        : fillTemplate(kind === "invoice" ? templates.invoice : templates.reminder, vars);

    const { buffer, filename } = await renderInvoicePdf(inv.id);

    try {
      const wamId = await sendPdf(companyId, phone, buffer, filename, body);
      await recordSend({
        companyId,
        invoiceId: inv.id,
        clientId: inv.client_id ?? null,
        phone,
        kind,
        body,
        status: "sent",
        error: null,
        wamId,
        userId: req.user!.id,
      });
      res.json({ ok: true, wamId, phone });
    } catch (sendErr: any) {
      await recordSend({
        companyId,
        invoiceId: inv.id,
        clientId: inv.client_id ?? null,
        phone,
        kind,
        body,
        status: "failed",
        error: sendErr?.message || String(sendErr),
        wamId: null,
        userId: req.user!.id,
      });
      res
        .status(sendErr?.code === "WA_NOT_CONNECTED" ? 409 : 502)
        .json({ error: sendErr?.message || "Failed to send" });
    }
  } catch (err: any) {
    if (err?.code === "INVOICE_NOT_FOUND") {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    next(err);
  }
}

// Filled message preview — what will actually be sent (WYSIWYG for the modal).
router.get("/send/:kind/:id/preview", async (req, res, next) => {
  try {
    const kind = req.params.kind === "reminder" ? "reminder" : "invoice";
    const inv = await loadInvoiceForSend(req.params.id);
    if (!inv) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const templates = await loadTemplates();
    const origin = `${req.protocol}://${req.get("host")}`;
    const previousBalance = await previousClientBalance(
      { query },
      {
        clientId: inv.client_id,
        invoiceDate: String(inv.invoice_date).slice(0, 10),
        invoiceId: inv.id,
      }
    );
    const vars = invoiceVars(inv, {
      items: inv.items,
      previousBalance,
      invoiceLink: publicInvoiceUrl(inv.id, origin),
    });
    res.json({
      message: fillTemplate(kind === "invoice" ? templates.invoice : templates.reminder, vars),
      phone: inv.client_phone || "",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/send/invoice/:id", (req: AuthRequest, res, next) =>
  handleDocumentSend(req, res, next, "invoice")
);
router.post("/send/reminder/:id", (req: AuthRequest, res, next) =>
  handleDocumentSend(req, res, next, "reminder")
);

router.post("/send/text/:id", async (req: AuthRequest, res, next) => {
  try {
    const inv = await loadInvoiceForSend(req.params.id);
    if (!inv) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    if (!inv.company_id) {
      res.status(400).json({ error: "This invoice has no company." });
      return;
    }
    const companyId = Number(inv.company_id);
    const phone = String(req.body.phone || inv.client_phone || "").trim();
    const body = String(req.body.message || "").trim();
    if (!phone) {
      res.status(400).json({ error: "No phone number." });
      return;
    }
    if (!body) {
      res.status(400).json({ error: "Message is empty." });
      return;
    }
    try {
      const wamId = await sendText(companyId, phone, body);
      await recordSend({
        companyId,
        invoiceId: inv.id,
        clientId: inv.client_id ?? null,
        phone,
        kind: "text",
        body,
        status: "sent",
        error: null,
        wamId,
        userId: req.user!.id,
      });
      res.json({ ok: true, wamId, phone });
    } catch (sendErr: any) {
      await recordSend({
        companyId,
        invoiceId: inv.id,
        clientId: inv.client_id ?? null,
        phone,
        kind: "text",
        body,
        status: "failed",
        error: sendErr?.message || String(sendErr),
        wamId: null,
        userId: req.user!.id,
      });
      res
        .status(sendErr?.code === "WA_NOT_CONNECTED" ? 409 : 502)
        .json({ error: sendErr?.message || "Failed to send" });
    }
  } catch (err) {
    next(err);
  }
});

// ---- invoice-send history ------------------------------------------

router.get("/log", async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT m.id, m.invoice_id, m.phone, m.kind, m.status, m.error, m.created_at,
              i.number AS invoice_number, cl.name AS client_name, u.name AS sent_by
       FROM wa_messages m
       LEFT JOIN invoices i ON i.id = m.invoice_id
       LEFT JOIN clients cl ON cl.id = m.client_id
       LEFT JOIN users u ON u.id = m.created_by
       ORDER BY m.id DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/log/:invoiceId", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT m.id, m.phone, m.kind, m.status, m.error, m.body, m.created_at,
              u.name AS sent_by
       FROM wa_messages m
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.invoice_id = ?
       ORDER BY m.id DESC`,
      [req.params.invoiceId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
