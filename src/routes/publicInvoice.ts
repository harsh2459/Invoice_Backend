/**
 * Public, no-auth invoice links for sharing on WhatsApp.
 *
 *   GET /api/public/invoice/:token        → inline PDF
 *   GET /api/public/invoice/:token/view   → tiny HTML page that embeds the PDF
 *
 * The token is an HMAC of the invoice id keyed by JWT_SECRET, so links are
 * unguessable and don't need a DB column. `publicInvoiceUrl(id)` builds the
 * absolute URL (PUBLIC_BASE_URL env, else falls back to the request origin).
 */
import { Router } from "express";
import crypto from "crypto";
import { config } from "../config";
import { renderInvoicePdf } from "../invoicePdf";

const router = Router();

export function invoiceToken(id: number | string): string {
  return crypto
    .createHmac("sha256", config.jwtSecret)
    .update(`invoice:${id}`)
    .digest("base64url")
    .slice(0, 22);
}

/** Absolute public URL for an invoice's shareable PDF. */
export function publicInvoiceUrl(id: number | string, reqOrigin?: string): string {
  const base = (process.env.PUBLIC_BASE_URL || reqOrigin || "").replace(/\/+$/, "");
  return `${base}/api/public/invoice/${id}-${invoiceToken(id)}`;
}

function parseToken(raw: string): number | null {
  const m = String(raw).match(/^(\d+)-([A-Za-z0-9_-]{22})$/);
  if (!m) return null;
  const id = Number(m[1]);
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(invoiceToken(id))) ? id : null;
}

router.get("/invoice/:token", async (req, res, next) => {
  try {
    const id = parseToken(req.params.token);
    if (!id) {
      res.status(404).send("Not found");
      return;
    }
    const { buffer, filename } = await renderInvoicePdf(id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.send(buffer);
  } catch (err: any) {
    if (err?.code === "INVOICE_NOT_FOUND") {
      res.status(404).send("Invoice not found");
      return;
    }
    next(err);
  }
});

export default router;
