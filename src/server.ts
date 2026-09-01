import "dotenv/config";
import http from "http";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import path from "path";
import authRoutes from "./routes/auth";
import usersRoutes from "./routes/users";
import paymentsRoutes from "./routes/payments";
import salesRoutes from "./routes/sales";
import expensesRoutes from "./routes/expenses";
import exportRoutes from "./routes/export";
import reportsRoutes from "./routes/reports";
import { platformsRouter, categoriesRouter } from "./routes/lookups";
import companiesRoutes from "./routes/companies";
import clientsRoutes from "./routes/clients";
import productsRoutes from "./routes/products";
import invoicesRoutes from "./routes/invoices";
import suppliersRoutes from "./routes/suppliers";
import purchasesRoutes from "./routes/purchases";
import bankAccountsRoutes from "./routes/bankAccounts";
import whatsappRoutes from "./routes/whatsapp";
import collatorRoutes from "./routes/collator";
import { initDb } from "./db";
import { config } from "./config";
import { initAll as initWhatsAppAll } from "./whatsapp";
import { attachWaSocket } from "./waSocketBridge";

const app = express();

// CORS: allow all by default; set CORS_ORIGIN (comma-separated) in production to
// restrict to your deployed frontend origin(s).
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins, credentials: true } : {}));
app.use(express.json({ limit: "25mb" }));

// Health check for the hosting platform.
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/platforms", platformsRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/companies", companiesRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/invoices", invoicesRoutes);
app.use("/api/suppliers", suppliersRoutes);
app.use("/api/purchases", purchasesRoutes);
app.use("/api/bank-accounts", bankAccountsRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/collator", collatorRoutes);

// Serve the built frontend unless explicitly disabled. The API is mounted above,
// so this only handles non-/api paths.
if (process.env.SERVE_CLIENT !== "false") {
  const clientDir = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(clientDir));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const server = http.createServer(app);
attachWaSocket(server);

initDb()
  .then(() => {
    server.listen(config.port, "0.0.0.0", () => {
      console.log(`Server running on http://0.0.0.0:${config.port} (reachable on this machine's LAN IP)`);
    });
    // Supervise every company that has ever paired — resume its session, keep it
    // connected forever. Never blocks startup; state is polled via the API.
    initWhatsAppAll().catch((err) => console.error("[wa] initAll error:", err));
  })
  .catch((err) => {
    console.error("Failed to initialise database:", err);
    process.exit(1);
  });
