/**
 * Collator import routes — upload only (no NAS browser).
 *   POST /api/collator/imports/upload   multipart: file[, company_id, data_month, data_year]
 *   GET  /api/collator/imports/logs
 *   DELETE /api/collator/imports/logs/:id?delete_data=<bool>
 */
import { Router } from "express";
import multer from "multer";
import { query, exec } from "../../db";
import { runImport, deleteImportData } from "../../collator/importRunner";
import type { AuthRequest } from "../../middleware/auth";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

router.post("/upload", upload.single("file"), async (req: AuthRequest, res, next) => {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const num = (v: unknown) => (v === undefined || v === "" || v === null ? null : Number(v));
    const result = await runImport({
      buffer: file.buffer,
      filename: file.originalname,
      companyId: num(req.body.company_id),
      dataMonth: num(req.body.data_month),
      dataYear: num(req.body.data_year),
    });
    const code = result.status === "failed" ? 500 : 200;
    res.status(code).json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/logs", async (req, res, next) => {
  try {
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    if (req.query.company_id) {
      clauses.push("m.company_id = ?");
      params.push(Number(req.query.company_id));
    }
    if (req.query.platform) {
      clauses.push("m.platform = ?");
      params.push(String(req.query.platform));
    }
    if (req.query.status) {
      clauses.push("m.status = ?");
      params.push(String(req.query.status));
    }
    if (req.query.year) {
      clauses.push("YEAR(m.imported_at) = ?");
      params.push(Number(req.query.year));
    }
    if (req.query.month) {
      clauses.push("MONTH(m.imported_at) = ?");
      params.push(Number(req.query.month));
    }
    const where = clauses.join(" AND ");

    const totalRow = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM col_import_logs m WHERE ${where}`,
      params
    );
    const logs = await query(
      `SELECT m.*, co.name AS company_name
       FROM col_import_logs m
       LEFT JOIN companies co ON co.id = m.company_id
       WHERE ${where}
       ORDER BY m.imported_at DESC, m.id DESC
       LIMIT ?`,
      [...params, limit]
    );
    res.json({ total: Number(totalRow[0]?.n || 0), logs });
  } catch (err) {
    next(err);
  }
});

router.delete("/logs/:id", async (req, res, next) => {
  try {
    const rows = await query<{ platform: string; file_path: string }>(
      "SELECT platform, file_path FROM col_import_logs WHERE id = ?",
      [req.params.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Log not found" });
      return;
    }
    const deleteData = String(req.query.delete_data) === "true";
    let rowsDeleted = 0;
    if (deleteData && rows[0].file_path) {
      rowsDeleted = await deleteImportData(rows[0].platform, rows[0].file_path);
    }
    await exec("DELETE FROM col_import_logs WHERE id = ?", [req.params.id]);
    res.json({ status: "deleted", rows_deleted: rowsDeleted });
  } catch (err) {
    next(err);
  }
});

export default router;
