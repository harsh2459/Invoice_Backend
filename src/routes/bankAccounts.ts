import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const where = companyId ? "WHERE ba.company_id = ?" : "";
    const params = companyId ? [companyId] : [];
    const rows = await query(
      `SELECT ba.id, ba.company_id, ba.name, ba.last4, co.name AS company_name,
              (SELECT COUNT(*) FROM invoice_payments ip WHERE ip.bank_account_id = ba.id) AS payment_count
       FROM bank_accounts ba
       JOIN companies co ON co.id = ba.company_id
       ${where}
       ORDER BY co.name, ba.name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT ba.id, ba.company_id, ba.name, ba.last4, co.name AS company_name,
              (SELECT COUNT(*) FROM invoice_payments ip WHERE ip.bank_account_id = ba.id) AS payment_count
       FROM bank_accounts ba
       JOIN companies co ON co.id = ba.company_id
       WHERE ba.id = ?`,
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Bank account not found" });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

interface ParsedBank {
  company_id: number;
  name: string;
  last4: string | null;
}

function parseBody(body: any): ParsedBank | string {
  const company_id = Number(body.company_id);
  if (!company_id) return "Company is required";
  const name = (body.name || "").trim();
  if (!name) return "Name is required";
  let last4: string | null = (body.last4 || "").trim() || null;
  if (last4 && !/^\d{1,4}$/.test(last4)) return "Last 4 digits must be 1–4 digits";
  return { company_id, name, last4 };
}

router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const parsed = parseBody(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    try {
      const result = await exec(
        "INSERT INTO bank_accounts (company_id, name, last4) VALUES (?, ?, ?)",
        [parsed.company_id, parsed.name, parsed.last4]
      );
      res.json({ id: result.insertId, ...parsed });
    } catch (err: any) {
      if (err?.code === "ER_NO_REFERENCED_ROW_2") {
        res.status(400).json({ error: "That company does not exist" });
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
    const parsed = parseBody(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    const existing = await query<{ company_id: number }>(
      "SELECT company_id FROM bank_accounts WHERE id = ?",
      [req.params.id]
    );
    if (!existing[0]) {
      res.status(404).json({ error: "Bank account not found" });
      return;
    }
    if (existing[0].company_id !== parsed.company_id) {
      const used = await query<{ c: number }>(
        `SELECT COUNT(*) AS c FROM invoice_payments WHERE bank_account_id = ?`,
        [req.params.id]
      );
      if ((used[0]?.c ?? 0) > 0) {
        res
          .status(400)
          .json({ error: "This bank account already has payments; its company can't be changed." });
        return;
      }
    }
    await exec("UPDATE bank_accounts SET company_id = ?, name = ?, last4 = ? WHERE id = ?", [
      parsed.company_id,
      parsed.name,
      parsed.last4,
      req.params.id,
    ]);
    res.json({ id: Number(req.params.id), ...parsed });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const used = await query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM invoice_payments WHERE bank_account_id = ?",
      [req.params.id]
    );
    if ((used[0]?.c ?? 0) > 0) {
      res.status(409).json({
        error: `This bank account is used by ${used[0]!.c} payment${
          used[0]!.c === 1 ? "" : "s"
        } and can't be deleted.`,
      });
      return;
    }
    await exec("DELETE FROM bank_accounts WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
