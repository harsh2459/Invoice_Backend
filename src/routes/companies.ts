import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const rows = await query(
      "SELECT id, name, address, phone, email, gstin, invoice_prefix, short_code, active, color FROM companies ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query<any>(
      "SELECT id, name, address, phone, email, gstin, logo, invoice_prefix, short_code, active, color FROM companies WHERE id = ?",
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const clients = await query(
      `SELECT c.id, c.name FROM clients c
       JOIN company_clients cc ON cc.client_id = c.id
       WHERE cc.company_id = ?
       ORDER BY c.name`,
      [req.params.id]
    );
    res.json({ ...rows[0], clients });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/clients", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT c.id, c.name, c.address, c.phone, c.email, c.gstin
       FROM clients c
       JOIN company_clients cc ON cc.client_id = c.id
       WHERE cc.company_id = ?
       ORDER BY c.name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/products", async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT p.id, p.name, p.unit, p.default_rate, p.gst_rate, p.hsn
       FROM products p
       JOIN company_products cp ON cp.product_id = p.id
       WHERE cp.company_id = ?
       ORDER BY p.name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
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
    const { address, phone, email, gstin, logo, invoice_prefix } = req.body;
    const short_code = (req.body.short_code || "").trim().toUpperCase() || null;
    const active = req.body.active === undefined ? 1 : req.body.active ? 1 : 0;
    const color = (req.body.color || "").trim() || "#1a6fd4";
    try {
      const result = await exec(
        "INSERT INTO companies (name, address, phone, email, gstin, logo, invoice_prefix, short_code, active, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [name, address || null, phone || null, email || null, gstin || null, logo || null, (invoice_prefix || "").trim() || null, short_code, active, color]
      );
      res.json({ id: result.insertId, name, address, phone, email, gstin, logo: logo || null, invoice_prefix: invoice_prefix || null, short_code, active, color });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        res.status(400).json({ error: "A company with that name or code already exists" });
        return;
      }
      throw err;
    }
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
    const { address, phone, email, gstin, logo, invoice_prefix } = req.body;
    const short_code = (req.body.short_code || "").trim().toUpperCase() || null;
    const active = req.body.active === undefined ? 1 : req.body.active ? 1 : 0;
    const color = (req.body.color || "").trim() || "#1a6fd4";
    try {
      const result = await exec(
        "UPDATE companies SET name = ?, address = ?, phone = ?, email = ?, gstin = ?, logo = ?, invoice_prefix = ?, short_code = ?, active = ?, color = ? WHERE id = ?",
        [name, address || null, phone || null, email || null, gstin || null, logo || null, (invoice_prefix || "").trim() || null, short_code, active, color, req.params.id]
      );
      if (result.affectedRows === 0) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      res.json({ id: Number(req.params.id), name, address, phone, email, gstin, logo: logo || null, invoice_prefix: invoice_prefix || null, short_code, active, color });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        res.status(400).json({ error: "A company with that name or code already exists" });
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
      "SELECT COUNT(*) AS c FROM invoices WHERE company_id = ?",
      [req.params.id]
    );
    if ((used[0]?.c ?? 0) > 0) {
      res.status(409).json({
        error: `This company is on ${used[0]!.c} invoice${used[0]!.c === 1 ? "" : "s"} and can't be deleted.`,
      });
      return;
    }
    await exec("DELETE FROM companies WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
