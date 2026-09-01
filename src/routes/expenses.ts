import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(authenticate, requireAdmin);

router.get("/", async (req, res, next) => {
  try {
    const expenses = await query("SELECT * FROM expenses ORDER BY date DESC, id DESC");
    res.json(expenses);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req: AuthRequest, res, next) => {
  try {
    const { date, category, amount, notes } = req.body;
    if (!date || !category || !(amount > 0)) {
      res.status(400).json({ error: "Invalid expense" });
      return;
    }
    const result = await exec(
      "INSERT INTO expenses (date, category, amount, notes, created_by) VALUES (?, ?, ?, ?, ?)",
      [date, category, amount, notes || null, req.user!.id]
    );
    res.json({ id: result.insertId, date, category, amount, notes });
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const { date, category, amount, notes } = req.body;
    if (!date || !category || !(amount > 0)) {
      res.status(400).json({ error: "Invalid expense" });
      return;
    }
    const result = await exec(
      "UPDATE expenses SET date = ?, category = ?, amount = ?, notes = ? WHERE id = ?",
      [date, category, amount, notes || null, req.params.id]
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ error: "Expense not found" });
      return;
    }
    res.json({ id: Number(req.params.id), date, category, amount, notes });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await exec("DELETE FROM expenses WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
