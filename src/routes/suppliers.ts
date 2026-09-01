import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT s.id, s.name, s.address, s.phone, s.email, s.gstin,
              (SELECT COUNT(*) FROM company_suppliers cs WHERE cs.supplier_id = s.id) AS company_count
       FROM suppliers s
       ORDER BY s.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query<any>(
      "SELECT id, name, address, phone, email, gstin FROM suppliers WHERE id = ?",
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }
    const companies = await query(
      `SELECT co.id, co.name FROM companies co
       JOIN company_suppliers cs ON cs.company_id = co.id
       WHERE cs.supplier_id = ?
       ORDER BY co.name`,
      [req.params.id]
    );
    res.json({ ...rows[0], companies });
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
    const { address, phone, email, gstin } = req.body;
    const result = await exec(
      "INSERT INTO suppliers (name, address, phone, email, gstin) VALUES (?, ?, ?, ?, ?)",
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
      "UPDATE suppliers SET name = ?, address = ?, phone = ?, email = ?, gstin = ? WHERE id = ?",
      [name, address || null, phone || null, email || null, gstin || null, req.params.id]
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }
    res.json({ id: Number(req.params.id), name, address, phone, email, gstin });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const used = await query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM purchase_invoices WHERE supplier_id = ?",
      [req.params.id]
    );
    if ((used[0]?.c ?? 0) > 0) {
      res.status(409).json({
        error: `This supplier is on ${used[0]!.c} bill${used[0]!.c === 1 ? "" : "s"} and can't be deleted.`,
      });
      return;
    }
    await exec("DELETE FROM suppliers WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- company links (many-to-many, managed from the supplier side) ----

router.post("/:id/companies", requireAdmin, async (req, res, next) => {
  try {
    const companyId = Number(req.body.company_id);
    if (!companyId) {
      res.status(400).json({ error: "company_id is required" });
      return;
    }
    try {
      await exec(
        "INSERT INTO company_suppliers (company_id, supplier_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE supplier_id = supplier_id",
        [companyId, req.params.id]
      );
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.code === "ER_NO_REFERENCED_ROW_2") {
        res.status(400).json({ error: "That company or supplier does not exist" });
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
    await exec("DELETE FROM company_suppliers WHERE supplier_id = ? AND company_id = ?", [
      req.params.id,
      req.params.companyId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
