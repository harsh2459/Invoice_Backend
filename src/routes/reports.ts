import { Router } from "express";
import { authenticate, AuthRequest } from "../middleware/auth";
import {
  getSummary,
  getByPlatform,
  getByEmployee,
  getExpenses,
  getEmployeeReport,
  getInvoiceSummary,
  getCollectedByBank,
  RangeOpts,
} from "../reports";
import { requireAdmin } from "../middleware/auth";

const router = Router();
router.use(authenticate);

function rangeFromReq(req: AuthRequest): RangeOpts {
  const start = req.query.start as string | undefined;
  const end = req.query.end as string | undefined;
  const opts: RangeOpts = {};
  if (start && end) {
    opts.start = start;
    opts.end = end;
  }
  if (req.user!.role !== "admin") opts.employeeId = req.user!.id;
  return opts;
}

router.get("/summary", async (req: AuthRequest, res, next) => {
  try {
    res.json(await getSummary(rangeFromReq(req)));
  } catch (err) {
    next(err);
  }
});

router.get("/by-platform", async (req: AuthRequest, res, next) => {
  try {
    res.json(await getByPlatform(rangeFromReq(req)));
  } catch (err) {
    next(err);
  }
});

router.get("/by-employee", async (req: AuthRequest, res, next) => {
  try {
    res.json(await getByEmployee(rangeFromReq(req)));
  } catch (err) {
    next(err);
  }
});

router.get("/expenses", async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== "admin") {
      res.json([]);
      return;
    }
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    const opts: RangeOpts = start && end ? { start, end } : {};
    res.json(await getExpenses(opts));
  } catch (err) {
    next(err);
  }
});

function invoiceRange(req: AuthRequest): RangeOpts {
  const start = req.query.start as string | undefined;
  const end = req.query.end as string | undefined;
  const opts: RangeOpts = start && end ? { start, end } : {};
  if (req.query.company_id) opts.companyId = Number(req.query.company_id);
  return opts;
}

router.get("/invoice-summary", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    res.json(await getInvoiceSummary(invoiceRange(req)));
  } catch (err) {
    next(err);
  }
});

router.get("/collected-by-bank", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    res.json(await getCollectedByBank(invoiceRange(req)));
  } catch (err) {
    next(err);
  }
});

router.get("/employee/:id", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const start = req.query.start as string | undefined;
    const end = req.query.end as string | undefined;
    res.json(await getEmployeeReport(Number(req.params.id), start, end));
  } catch (err) {
    next(err);
  }
});

export default router;
