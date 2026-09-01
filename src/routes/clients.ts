import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, requireAdmin } from "../middleware/auth";
import { refreshClientRoster } from "../whatsapp";

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
