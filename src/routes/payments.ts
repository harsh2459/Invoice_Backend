import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(authenticate, requireAdmin);

router.get("/", async (req, res, next) => {
  try {
    const payments = await query("SELECT * FROM payments ORDER BY date DESC, id DESC");
    res.json(payments);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req: AuthRequest, res, next) => {
  try {
    const { date, platform, amount, notes } = req.body;
    if (!date || !platform || !(amount > 0)) {
      res.status(400).json({ error: "Invalid payment" });
      return;
    }
    const result = await exec(
      "INSERT INTO payments (date, platform, amount, notes, created_by) VALUES (?, ?, ?, ?, ?)",
      [date, platform, amount, notes || null, req.user!.id]
    );
    res.json({ id: result.insertId, date, platform, amount, notes });
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const { date, platform, amount, notes } = req.body;
    if (!date || !platform || !(amount > 0)) {
      res.status(400).json({ error: "Invalid payment" });
      return;
    }
    const result = await exec(
      "UPDATE payments SET date = ?, platform = ?, amount = ?, notes = ? WHERE id = ?",
      [date, platform, amount, notes || null, req.params.id]
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    res.json({ id: Number(req.params.id), date, platform, amount, notes });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await exec("DELETE FROM payments WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
