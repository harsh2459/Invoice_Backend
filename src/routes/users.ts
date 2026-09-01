import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, exec } from "../db";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();
router.use(authenticate, requireAdmin);

router.get("/", async (req, res, next) => {
  try {
    const users = await query(
      "SELECT id, name, email, username, role, created_at FROM users ORDER BY created_at DESC"
    );
    res.json(users);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, email, username, password, role } = req.body;

    if (!name || !role) {
      res.status(400).json({ error: "Name and role are required" });
      return;
    }

    if (role === "admin" && (!username || !password)) {
      res.status(400).json({ error: "Admin users need a username and password" });
      return;
    }

    try {
      // Employees are name-only records with no login; admins get credentials.
      const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
      const result = await exec(
        "INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)",
        [name, email || null, username || null, passwordHash, role]
      );
      res.json({ id: result.insertId, name, email: email || null, username: username || null, role });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        res.status(400).json({ error: "Username or email already exists" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await exec("DELETE FROM users WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
