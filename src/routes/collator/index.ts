/**
 * Collator module — mounted at /api/collator, admin-only.
 * Phase A: imports (upload), data browsers, dashboard.
 * Companies are shared with the Invoicing module via /api/companies (the
 * frontend just adds short_code/active/color to the same records).
 */
import { Router } from "express";
import { authenticate, requireAdmin } from "../../middleware/auth";
import importsRoutes from "./imports";
import dataRoutes from "./data";
import dashboardRoutes from "./dashboard";
import pnlRoutes from "./pnl";
import purchasesRoutes from "./purchases";
import ledgerRoutes from "./ledger";

const router = Router();
router.use(authenticate, requireAdmin);

router.use("/imports", importsRoutes);
router.use("/data", dataRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/pnl", pnlRoutes);
router.use("/purchases", purchasesRoutes);
router.use("/ledger", ledgerRoutes);

export default router;
