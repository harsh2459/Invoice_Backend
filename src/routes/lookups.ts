import { Router } from "express";
import { query, exec } from "../db";
import { authenticate, requireAdmin } from "../middleware/auth";

// Which entry table/column stores this lookup's value as free text.
const USAGE: Record<"platforms" | "categories", { table: string; column: string }> = {
  platforms: { table: "payments", column: "platform" },
  categories: { table: "expenses", column: "category" },
};

// Shared CRUD for the two simple lookup tables (platforms, categories).
function lookupRouter(table: "platforms" | "categories") {
  const router = Router();
  router.use(authenticate);

  router.get("/", async (req, res, next) => {
    try {
      const rows = await query(`SELECT id, name FROM ${table} ORDER BY name`);
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
      try {
        const result = await exec(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
        res.json({ id: result.insertId, name });
      } catch (err: any) {
        if (err?.code === "ER_DUP_ENTRY") {
          res.status(400).json({ error: "That name already exists" });
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
      const rows = await query<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, [
        req.params.id,
      ]);
      const name = rows[0]?.name;
      if (!name) {
        res.json({ ok: true });
        return;
      }

      const { table: usageTable, column } = USAGE[table];
      const used = await query<{ c: number }>(
        `SELECT COUNT(*) AS c FROM ${usageTable} WHERE ${column} = ?`,
        [name]
      );
      if ((used[0]?.c ?? 0) > 0) {
        res.status(409).json({
          error: `"${name}" is used by ${used[0]!.c} ${usageTable} entr${
            used[0]!.c === 1 ? "y" : "ies"
          } and can't be deleted.`,
        });
        return;
      }

      await exec(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const platformsRouter = lookupRouter("platforms");
export const categoriesRouter = lookupRouter("categories");
