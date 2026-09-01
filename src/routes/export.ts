import { Router } from "express";
import ExcelJS from "exceljs";
import { query } from "../db";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import { getSummary, getByPlatform, getByEmployee, getEmployeeReport } from "../reports";
import { PDFDocument, ddmmyyyy, INR, drawTable } from "../pdf";

const router = Router();
router.use(authenticate, requireAdmin);

router.get("/excel", async (req, res, next) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const salesSheet = workbook.addWorksheet("Sales");

    salesSheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Date", key: "date", width: 15 },
      { header: "Employee", key: "employee_name", width: 20 },
      { header: "Amount", key: "amount", width: 15 },
      { header: "Notes", key: "notes", width: 30 },
    ];

    const sales = await query(`
      SELECT s.*, u.name as employee_name
      FROM sales s
      JOIN users u ON s.employee_id = u.id
      ORDER BY s.date DESC
    `);
    salesSheet.addRows((sales as any[]).map((r) => ({ ...r, date: ddmmyyyy(r.date) })));

    const paymentsSheet = workbook.addWorksheet("Payments");
    paymentsSheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Date", key: "date", width: 15 },
      { header: "Platform", key: "platform", width: 15 },
      { header: "Amount", key: "amount", width: 15 },
      { header: "Notes", key: "notes", width: 30 },
    ];
    const payments = await query("SELECT * FROM payments ORDER BY date DESC");
    paymentsSheet.addRows((payments as any[]).map((r) => ({ ...r, date: ddmmyyyy(r.date) })));

    const expensesSheet = workbook.addWorksheet("Expenses");
    expensesSheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Date", key: "date", width: 15 },
      { header: "Category", key: "category", width: 20 },
      { header: "Amount", key: "amount", width: 15 },
      { header: "Notes", key: "notes", width: 30 },
    ];
    const expenses = await query("SELECT * FROM expenses ORDER BY date DESC");
    expensesSheet.addRows((expenses as any[]).map((r) => ({ ...r, date: ddmmyyyy(r.date) })));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=CashFlow_Export.xlsx");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get("/report-pdf", async (req: AuthRequest, res, next) => {
  try {
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    const opts = start && end ? { start, end } : {};

    const [summary, byPlatform, byEmployee] = await Promise.all([
      getSummary(opts),
      getByPlatform(opts),
      getByEmployee(opts),
    ]);

    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=CashFlow_Report.pdf");
    doc.pipe(res);

    doc.font("Helvetica-Bold").fontSize(18).text("CashFlow - Report");
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555555")
      .text(start && end ? `Period: ${ddmmyyyy(start)} to ${ddmmyyyy(end)}` : "Period: All time");
    doc.fillColor("black").moveDown(1);

    doc.font("Helvetica-Bold").fontSize(12).text("Totals");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(10);
    doc.text(`Sales logged:      ${INR(summary.sales)}`);
    doc.text(`Payments received: ${INR(summary.payments)}`);
    doc.text(`Expenses:          ${INR(summary.expenses)}`);
    doc.font("Helvetica-Bold").text(`Net (Payments - Expenses): ${INR(summary.net)}`);
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(12).text("Payments by Platform");
    doc.moveDown(0.3);
    if (byPlatform.length === 0) {
      doc.font("Helvetica").fontSize(9).text("No payments for this period.");
    } else {
      drawTable(
        doc,
        ["Platform", "Payments"],
        byPlatform.map((p) => [p.platform, INR(p.payments)]),
        [220, 200]
      );
    }
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(12).text("By Employee");
    doc.moveDown(0.3);
    if (byEmployee.length === 0) {
      doc.font("Helvetica").fontSize(9).text("No sales entries for this period.");
    } else {
      drawTable(
        doc,
        ["Employee", "Entries", "Total Sales"],
        byEmployee.map((e) => [e.employee_name, e.count, INR(e.total)]),
        [200, 120, 180]
      );
    }

    doc.moveDown(2);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#888888")
      .text(`Generated ${new Date().toLocaleString("en-IN")}`);

    doc.end();
  } catch (err) {
    next(err);
  }
});

router.get("/employee-pdf", async (req: AuthRequest, res, next) => {
  try {
    const id = Number(req.query.id);
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    const rep = await getEmployeeReport(id, start, end);

    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Employee_Report_${(rep.employee?.name || "unknown").replace(
        /\s+/g,
        "_"
      )}.pdf`
    );
    doc.pipe(res);

    doc.font("Helvetica-Bold").fontSize(18).text("Employee Sales Report");
    doc
      .font("Helvetica")
      .fontSize(11)
      .text(rep.employee?.name || `Employee #${id}`);
    doc
      .fontSize(10)
      .fillColor("#555555")
      .text(
        start && end ? `Period: ${ddmmyyyy(start)} to ${ddmmyyyy(end)}` : "Period: All time"
      );
    doc.fillColor("black").moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10).text(`Entries: ${rep.count}`);
    doc.font("Helvetica-Bold").fontSize(12).text(`Total Sales: ${INR(rep.total)}`);
    doc.moveDown(1);

    if (rep.sales.length === 0) {
      doc.font("Helvetica").fontSize(9).text("No sales in this period.");
    } else {
      drawTable(
        doc,
        ["Date", "Notes", "Amount"],
        rep.sales.map((s) => [ddmmyyyy(s.date), s.notes || "", INR(s.amount)]),
        [110, 250, 150]
      );
    }

    doc.moveDown(2);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#888888")
      .text(`Generated ${new Date().toLocaleString("en-IN")}`);

    doc.end();
  } catch (err) {
    next(err);
  }
});

export default router;
