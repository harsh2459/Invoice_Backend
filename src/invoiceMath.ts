/**
 * Invoice totals. Single source of truth for POST /invoices, PUT /invoices/:id,
 * and the PDF. Discount is invoice-level only. Tax is per-line GST %, computed on
 * each line's taxable share (line amount minus its proportional slice of the
 * invoice discount).
 */

export interface RawItem {
  product_id: number | null;
  description: string;
  hsn: string | null;
  qty: number;
  rate: number;
  gst_rate: number;
}

export interface ComputedItem extends RawItem {
  amount: number; // qty * rate
  tax_amount: number; // gst on the discounted share
}

export interface InvoiceTotals {
  items: ComputedItem[];
  subtotal: number;
  discount_value: number;
  taxable: number;
  tax_total: number;
  total: number;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function computeTotals(
  rawItems: RawItem[],
  discount: number,
  discountIsPct: boolean
): InvoiceTotals {
  const items = rawItems.map((it) => ({
    ...it,
    amount: round2(it.qty * it.rate),
    tax_amount: 0,
  }));

  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));

  let discountValue = discountIsPct ? (subtotal * discount) / 100 : discount;
  discountValue = round2(Math.min(Math.max(discountValue, 0), subtotal));

  const taxable = round2(subtotal - discountValue);

  // Each line's taxable share is proportional to its amount.
  let taxTotal = 0;
  for (const it of items) {
    const share = subtotal > 0 ? it.amount / subtotal : 0;
    const lineTaxable = taxable * share;
    it.tax_amount = round2((lineTaxable * it.gst_rate) / 100);
    taxTotal += it.tax_amount;
  }
  taxTotal = round2(taxTotal);

  return {
    items,
    subtotal,
    discount_value: discountValue,
    taxable,
    tax_total: taxTotal,
    total: round2(taxable + taxTotal),
  };
}

export function paymentStatus(total: number, paid: number): "unpaid" | "partial" | "paid" {
  if (paid <= 0) return "unpaid";
  if (paid + 0.005 >= total) return "paid";
  return "partial";
}

// Minimal shape of the tx object from db.ts withTransaction().
interface Tx {
  query: <R = any>(sql: string, params?: any[]) => Promise<R[]>;
  exec: (sql: string, params?: any[]) => Promise<{ affectedRows: number }>;
}

/**
 * Outstanding balance a client owed BEFORE the given invoice — the sum of
 * (total - amount_paid) across every other invoice for the same client that is
 * dated earlier (or same date with a lower id). Scope is the client across all
 * companies. Returns 0 when there is no client_id.
 *
 * `runner` is anything with a `query` method (the pool's `query` export, or a tx).
 */
export async function previousClientBalance(
  runner: { query: <R = any>(sql: string, params?: any[]) => Promise<R[]> },
  opts: { clientId: number | null; invoiceDate: string; invoiceId: number }
): Promise<number> {
  if (!opts.clientId) return 0;
  const rows = await runner.query<{ bal: string | number }>(
    `SELECT COALESCE(SUM(total - amount_paid), 0) AS bal
       FROM invoices
      WHERE client_id = ?
        AND id <> ?
        AND (invoice_date < ? OR (invoice_date = ? AND id < ?))`,
    [opts.clientId, opts.invoiceId, opts.invoiceDate, opts.invoiceDate, opts.invoiceId]
  );
  return round2(Number(rows[0]?.bal ?? 0));
}

/**
 * Recompute an invoice's `amount_paid` + `payment_status` from its
 * `invoice_payments` rows. Call inside a transaction after any payment mutation.
 */
export async function recomputeInvoicePayment(tx: Tx, invoiceId: number) {
  const inv = await tx.query<{ total: string | number }>(
    "SELECT total FROM invoices WHERE id = ?",
    [invoiceId]
  );
  const total = Number(inv[0]?.total ?? 0);
  const sum = await tx.query<{ paid: string | number }>(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM invoice_payments WHERE invoice_id = ?",
    [invoiceId]
  );
  const paid = round2(Number(sum[0]?.paid ?? 0));
  const status = paymentStatus(total, paid);
  await tx.exec("UPDATE invoices SET amount_paid = ?, payment_status = ? WHERE id = ?", [
    paid,
    status,
    invoiceId,
  ]);
  return { amount_paid: paid, payment_status: status, balance: round2(total - paid) };
}

/**
 * Same as recomputeInvoicePayment but for a purchase bill (purchase_invoices +
 * purchase_payments).
 */
export async function recomputePurchasePayment(tx: Tx, billId: number) {
  const b = await tx.query<{ total: string | number }>(
    "SELECT total FROM purchase_invoices WHERE id = ?",
    [billId]
  );
  const total = Number(b[0]?.total ?? 0);
  const sum = await tx.query<{ paid: string | number }>(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM purchase_payments WHERE purchase_invoice_id = ?",
    [billId]
  );
  const paid = round2(Number(sum[0]?.paid ?? 0));
  const status = paymentStatus(total, paid);
  await tx.exec(
    "UPDATE purchase_invoices SET amount_paid = ?, payment_status = ? WHERE id = ?",
    [paid, status, billId]
  );
  return { amount_paid: paid, payment_status: status, balance: round2(total - paid) };
}

/**
 * Format a company invoice number: `<PREFIX>-<YYYY>-<00001>`. Falls back to the
 * first 3 alnum chars of the company name (uppercased) when no prefix is set.
 */
export function formatInvoiceNumber(prefix: string | null, companyName: string, year: number, seq: number): string {
  const p =
    (prefix && prefix.trim()) ||
    (companyName || "INV").replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() ||
    "INV";
  return `${p}-${year}-${String(seq).padStart(5, "0")}`;
}
