/**
 * Inventory helpers. Stock is one global pool per product (products.stock_qty),
 * with an immutable ledger in stock_movements.
 *
 * A purchase bill ADDS stock for each tracked line item; a sales invoice DEDUCTS.
 * On edit we reverse the document's existing movements and re-apply the new
 * lines. All of this runs inside the caller's withTransaction().
 *
 * Negative stock is allowed — the UI flags "oversold" products.
 */

interface Tx {
  query: <R = any>(sql: string, params?: any[]) => Promise<R[]>;
  exec: (sql: string, params?: any[]) => Promise<{ affectedRows: number; insertId?: number }>;
}

export type RefType = "purchase_invoice" | "invoice" | "sales_return" | "purchase_return";
export type Reason = "purchase" | "sale" | "adjustment" | "opening" | "sales_return" | "purchase_return";

const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** Line items as stored on an invoice/bill (only product_id + qty matter here). */
export interface StockLine {
  product_id: number | null;
  qty: number;
}

/**
 * Apply stock movements for a document's line items.
 * `direction` is +1 for purchases (stock in), -1 for sales (stock out).
 * Aggregates by product so a document with the same product on two lines makes
 * one movement.
 */
export async function applyStockForDocument(
  tx: Tx,
  opts: {
    lines: StockLine[];
    direction: 1 | -1;
    refType: RefType;
    refId: number;
    userId: number | null;
    note?: string;
  }
): Promise<void> {
  const byProduct = new Map<number, number>();
  for (const l of opts.lines) {
    if (!l.product_id) continue;
    byProduct.set(l.product_id, (byProduct.get(l.product_id) || 0) + Number(l.qty || 0));
  }
  if (byProduct.size === 0) return;

  const reason: Reason =
    opts.refType === "sales_return"
      ? "sales_return"
      : opts.refType === "purchase_return"
      ? "purchase_return"
      : opts.direction === 1
      ? "purchase"
      : "sale";

  for (const [productId, qty] of byProduct) {
    if (!(qty > 0)) continue;
    const rows = await tx.query<{ track_stock: number; stock_qty: string | number }>(
      "SELECT track_stock, stock_qty FROM products WHERE id = ? FOR UPDATE",
      [productId]
    );
    if (!rows[0] || !rows[0].track_stock) continue; // service / not tracked

    const change = round3(opts.direction * qty);
    const balanceAfter = round3(Number(rows[0].stock_qty) + change);

    await tx.exec("UPDATE products SET stock_qty = ? WHERE id = ?", [balanceAfter, productId]);
    await tx.exec(
      `INSERT INTO stock_movements
         (product_id, change_qty, reason, ref_type, ref_id, note, balance_after, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [productId, change, reason, opts.refType, opts.refId, opts.note || null, balanceAfter, opts.userId]
    );
  }
}

/**
 * Reverse every stock movement previously recorded for a document, then delete
 * those ledger rows. Call before re-applying (edit) or on delete.
 */
export async function reverseStockForDocument(
  tx: Tx,
  refType: RefType,
  refId: number
): Promise<void> {
  const moves = await tx.query<{ id: number; product_id: number; change_qty: string | number }>(
    "SELECT id, product_id, change_qty FROM stock_movements WHERE ref_type = ? AND ref_id = ?",
    [refType, refId]
  );
  for (const m of moves) {
    const rows = await tx.query<{ stock_qty: string | number }>(
      "SELECT stock_qty FROM products WHERE id = ? FOR UPDATE",
      [m.product_id]
    );
    if (!rows[0]) continue;
    const restored = round3(Number(rows[0].stock_qty) - Number(m.change_qty));
    await tx.exec("UPDATE products SET stock_qty = ? WHERE id = ?", [restored, m.product_id]);
  }
  await tx.exec("DELETE FROM stock_movements WHERE ref_type = ? AND ref_id = ?", [refType, refId]);
}

/** Manual adjustment (from the Products screen). Positive adds, negative removes. */
export async function recordAdjustment(
  tx: Tx,
  opts: { productId: number; changeQty: number; note: string; userId: number | null }
): Promise<{ balanceAfter: number }> {
  const rows = await tx.query<{ track_stock: number; stock_qty: string | number }>(
    "SELECT track_stock, stock_qty FROM products WHERE id = ? FOR UPDATE",
    [opts.productId]
  );
  if (!rows[0]) throw Object.assign(new Error("Product not found"), { userError: true });
  const change = round3(opts.changeQty);
  const balanceAfter = round3(Number(rows[0].stock_qty) + change);
  await tx.exec("UPDATE products SET stock_qty = ? WHERE id = ?", [balanceAfter, opts.productId]);
  await tx.exec(
    `INSERT INTO stock_movements
       (product_id, change_qty, reason, ref_type, ref_id, note, balance_after, created_by)
     VALUES (?, ?, 'adjustment', 'manual', NULL, ?, ?, ?)`,
    [opts.productId, change, opts.note || null, balanceAfter, opts.userId]
  );
  return { balanceAfter };
}

/** Set opening stock: records an 'opening' movement for the delta to the target. */
export async function setOpeningStock(
  tx: Tx,
  opts: { productId: number; opening: number; userId: number | null }
): Promise<void> {
  const rows = await tx.query<{ stock_qty: string | number; opening_stock: string | number }>(
    "SELECT stock_qty, opening_stock FROM products WHERE id = ? FOR UPDATE",
    [opts.productId]
  );
  if (!rows[0]) return;
  const target = round3(opts.opening);
  const prevOpening = Number(rows[0].opening_stock);
  const delta = round3(target - prevOpening);
  if (delta === 0) return;
  const balanceAfter = round3(Number(rows[0].stock_qty) + delta);
  await tx.exec("UPDATE products SET stock_qty = ?, opening_stock = ? WHERE id = ?", [
    balanceAfter,
    target,
    opts.productId,
  ]);
  await tx.exec(
    `INSERT INTO stock_movements
       (product_id, change_qty, reason, ref_type, ref_id, note, balance_after, created_by)
     VALUES (?, ?, 'opening', 'manual', NULL, 'Opening stock', ?, ?)`,
    [opts.productId, delta, balanceAfter, opts.userId]
  );
}
