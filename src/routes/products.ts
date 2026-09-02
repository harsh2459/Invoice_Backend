import { Router } from "express";
import { query, exec, withTransaction } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import { recordAdjustment, setOpeningStock } from "../stock";

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    // Optional ?company_id= scopes to that company's assigned products.
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (companyId) {
      const rows = await query(
        `SELECT p.id, p.name, p.unit, p.default_rate, p.gst_rate, p.hsn,
                p.track_stock, p.stock_qty, p.reorder_level
         FROM products p
         JOIN company_products cp ON cp.product_id = p.id
         WHERE cp.company_id = ?
         ORDER BY p.name`,
        [companyId]
      );
      res.json(rows);
      return;
    }
    const rows = await query(
      `SELECT p.id, p.name, p.unit, p.default_rate, p.gst_rate, p.hsn,
              p.track_stock, p.stock_qty, p.reorder_level, p.opening_stock,
              (SELECT COUNT(*) FROM company_products cp WHERE cp.product_id = p.id) AS company_count
       FROM products p
       ORDER BY p.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Products at or below their reorder level (tracked items only).
router.get("/low-stock", async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT id, name, unit, stock_qty, reorder_level
       FROM products
       WHERE track_stock = 1 AND stock_qty <= reorder_level
       ORDER BY (stock_qty - reorder_level), name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT id, name, unit, default_rate, cost_price, gst_rate, hsn,
              track_stock, stock_qty, reorder_level, opening_stock
       FROM products WHERE id = ?`,
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    const companies = await query(
      `SELECT co.id, co.name FROM companies co
       JOIN company_products cp ON cp.company_id = co.id
       WHERE cp.product_id = ?
       ORDER BY co.name`,
      [req.params.id]
    );
    res.json({ ...rows[0], companies });
  } catch (err) {
    next(err);
  }
});

interface ParsedProduct {
  name: string;
  unit: string | null;
  default_rate: number;
  cost_price: number;
  gst_rate: number;
  hsn: string | null;
  track_stock: boolean;
  reorder_level: number;
  opening_stock: number;
}

function parseBody(body: any): ParsedProduct | string {
  const name = (body.name || "").trim();
  if (!name) return "Name is required";
  const rate = Number(body.default_rate ?? 0);
  if (!(rate >= 0) || Number.isNaN(rate)) return "Default rate must be zero or more";
  const cost = Number(body.cost_price ?? 0);
  if (!(cost >= 0) || Number.isNaN(cost)) return "Cost price must be zero or more";
  const gst = Number(body.gst_rate ?? 0);
  if (!(gst >= 0) || Number.isNaN(gst)) return "GST rate must be zero or more";
  const trackStock = body.track_stock === true || body.track_stock === 1 || body.track_stock === "1";
  const reorder = Number(body.reorder_level ?? 0);
  if (!(reorder >= 0) || Number.isNaN(reorder)) return "Reorder level must be zero or more";
  const opening = Number(body.opening_stock ?? 0);
  if (Number.isNaN(opening)) return "Opening stock must be a number";
  return {
    name,
    unit: (body.unit || "").trim() || null,
    default_rate: rate,
    cost_price: cost,
    gst_rate: gst,
    hsn: (body.hsn || "").trim() || null,
    track_stock: trackStock,
    reorder_level: reorder,
    opening_stock: opening,
  };
}

router.post("/", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const parsed = parseBody(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    try {
      const id = await withTransaction(async (tx) => {
        const result = await tx.exec(
          `INSERT INTO products (name, unit, default_rate, cost_price, gst_rate, hsn, track_stock, reorder_level)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            parsed.name,
            parsed.unit,
            parsed.default_rate,
            parsed.cost_price,
            parsed.gst_rate,
            parsed.hsn,
            parsed.track_stock ? 1 : 0,
            parsed.reorder_level,
          ]
        );
        const newId = result.insertId!;
        if (parsed.track_stock && parsed.opening_stock) {
          await setOpeningStock(tx, {
            productId: newId,
            opening: parsed.opening_stock,
            userId: req.user!.id,
          });
        }
        return newId;
      });
      res.json({ id, ...parsed });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        res.status(400).json({ error: "A product with that name already exists" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const parsed = parseBody(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    try {
      const affected = await withTransaction(async (tx) => {
        const result = await tx.exec(
          `UPDATE products SET name = ?, unit = ?, default_rate = ?, cost_price = ?, gst_rate = ?, hsn = ?,
             track_stock = ?, reorder_level = ? WHERE id = ?`,
          [
            parsed.name,
            parsed.unit,
            parsed.default_rate,
            parsed.cost_price,
            parsed.gst_rate,
            parsed.hsn,
            parsed.track_stock ? 1 : 0,
            parsed.reorder_level,
            req.params.id,
          ]
        );
        if (result.affectedRows > 0 && parsed.track_stock) {
          // adjust the 'opening' movement to the new target
          await setOpeningStock(tx, {
            productId: Number(req.params.id),
            opening: parsed.opening_stock,
            userId: req.user!.id,
          });
        }
        return result.affectedRows;
      });
      if (affected === 0) {
        res.status(404).json({ error: "Product not found" });
        return;
      }
      res.json({ id: Number(req.params.id), ...parsed });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        res.status(400).json({ error: "A product with that name already exists" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const used = await query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM invoice_items WHERE product_id = ?",
      [req.params.id]
    );
    if ((used[0]?.c ?? 0) > 0) {
      res.status(409).json({
        error: `This product is used on ${used[0]!.c} invoice line${used[0]!.c === 1 ? "" : "s"} and can't be deleted.`,
      });
      return;
    }
    await exec("DELETE FROM products WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- company links (which companies can invoice this product) ----

router.post("/:id/companies", requireAdmin, async (req, res, next) => {
  try {
    const companyId = Number(req.body.company_id);
    if (!companyId) {
      res.status(400).json({ error: "company_id is required" });
      return;
    }
    try {
      await exec(
        "INSERT INTO company_products (company_id, product_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE product_id = product_id",
        [companyId, req.params.id]
      );
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.code === "ER_NO_REFERENCED_ROW_2") {
        res.status(400).json({ error: "That company or product does not exist" });
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
    await exec("DELETE FROM company_products WHERE product_id = ? AND company_id = ?", [
      req.params.id,
      req.params.companyId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- stock ----

// Manual adjustment. body: { change_qty (+/-), note }
router.post("/:id/adjust", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const change = Number(req.body.change_qty);
    if (!change || Number.isNaN(change)) {
      res.status(400).json({ error: "Enter a non-zero quantity (use a minus sign to remove)" });
      return;
    }
    const result = await withTransaction((tx) =>
      recordAdjustment(tx, {
        productId: Number(req.params.id),
        changeQty: change,
        note: (req.body.note || "").trim() || "Manual adjustment",
        userId: req.user!.id,
      })
    );
    res.json({ id: Number(req.params.id), stock_qty: result.balanceAfter });
  } catch (err: any) {
    if (err?.userError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// Stock ledger for one product.
router.get("/:id/movements", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT m.id, m.change_qty, m.reason, m.ref_type, m.ref_id, m.note,
              m.balance_after, m.created_at, u.name AS by_name
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.product_id = ?
       ORDER BY m.id DESC
       LIMIT 200`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
