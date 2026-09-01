import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "../db";
import { config } from "../config";

const router = Router();
const JWT_SECRET = config.jwtSecret;

router.post("/login", async (req, res, next) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) {
      res.status(400).json({ error: "Missing login or password" });
      return;
    }

    // The login field can be either email or username
    const rows = await query<any>(
      "SELECT * FROM users WHERE email = ? OR username = ?",
      [login, login]
    );
    const user = rows[0];

    if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "1d" });
    res.json({
      token,
      user: { id: user.id, name: user.name, role: user.role, username: user.username, email: user.email },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
