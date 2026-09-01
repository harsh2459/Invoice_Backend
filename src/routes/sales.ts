import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, AuthRequest, requireAdmin } from "../middleware/auth";

const router = Router();
router.use(authenticate);

router.get("/", async (req: AuthRequest, res, next) => {
  try {
    let sales;
    if (req.user!.role === "admin") {
      sales = await query(`
        SELECT s.*, u.name as employee_name
        FROM sales s
        JOIN users u ON s.employee_id = u.id
        ORDER BY s.date DESC, s.id DESC
      `);
    } else {
      sales = await query(
        `
        SELECT s.*, u.name as employee_name
        FROM sales s
        JOIN users u ON s.employee_id = u.id
        WHERE s.employee_id = ?
        ORDER BY s.date DESC, s.id DESC
      `,
        [req.user!.id]
      );
    }
    res.json(sales);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req: AuthRequest, res, next) => {
  try {
    let { date, amount, notes, employee_id } = req.body;
    if (!date || !(amount > 0)) {
      res.status(400).json({ error: "Invalid sale data" });
      return;
    }

    if (req.user!.role !== "admin") {
      // Employees can only add sales for themselves
      employee_id = req.user!.id;
    } else if (!employee_id) {
      res.status(400).json({ error: "employee_id is required for admins adding a sale" });
      return;
    }

    const result = await exec(
      "INSERT INTO sales (date, employee_id, amount, notes) VALUES (?, ?, ?, ?)",
      [date, employee_id, amount, notes || null]
    );

    res.json({ id: result.insertId, date, employee_id, amount, notes });
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { date, amount, notes, employee_id } = req.body;
    if (!date || !employee_id || !(amount > 0)) {
      res.status(400).json({ error: "Invalid sale data" });
      return;
    }
    const result = await exec(
      "UPDATE sales SET date = ?, employee_id = ?, amount = ?, notes = ? WHERE id = ?",
      [date, employee_id, amount, notes || null, req.params.id]
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ error: "Sale not found" });
      return;
    }
    res.json({ id: Number(req.params.id), date, employee_id, amount, notes });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await exec("DELETE FROM sales WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
