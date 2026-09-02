/**
 * Invoicing Profit & Loss — trading account.
 *
 *   GET /api/pnl/summary?from=&to=&company_id=
 *   GET /api/pnl/by-product?from=&to=&company_id=
 *   GET /api/pnl/by-client?from=&to=&company_id=
 *   GET /api/pnl/by-supplier?from=&to=&company_id=
 *   GET /api/pnl/by-date?from=&to=&company_id=&bucket=day|month
 *
 * RIGHT (income): sales invoices.
 * LEFT (spend)  : purchases (supplier bills) + sales returns.
 * COGS is qty sold * product.cost_price (net of returns) — shown as an
 * information line; the two-sided statement uses actual purchases for spend.
 */
import { Router } from "express";
import { query } from "../db";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

const r2 = (n: unknown) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Shared window/company binder. */
function win(req: any) {
  const from = (req.query.from as string) || "1900-01-01";
  const to = (req.query.to as string) || "2999-12-31";
  const companyId = req.query.company_id ? Number(req.query.company_id) : null;
  return { from, to, companyId };
}

router.get("/summary", async (req, res, next) => {
  try {
    const { from, to, companyId } = win(req);
    const cInv = companyId ? "AND i.company_id = ?" : "";
    const cRet = companyId ? "AND sr.company_id = ?" : "";
    const cBill = companyId ? "AND b.company_id = ?" : "";
    const pInv: any[] = companyId ? [from, to, companyId] : [from, to];
    const pRet: any[] = companyId ? [from, to, companyId] : [from, to];
    const pBill: any[] = companyId ? [from, to, companyId] : [from, to];

    const [inv] = await query<any>(
      `SELECT COALESCE(SUM(i.total),0) gross, COALESCE(SUM(i.subtotal - i.discount_value),0) net_ex_gst,
              COALESCE(SUM(i.tax_total),0) gst, COUNT(*) n
         FROM invoices i WHERE i.invoice_date BETWEEN ? AND ? ${cInv}`,
      pInv
    );
    const [ret] = await query<any>(
      `SELECT COALESCE(SUM(sr.subtotal),0) net_ex_gst, COALESCE(SUM(sr.tax_total),0) gst,
              COALESCE(SUM(sr.total),0) gross, COUNT(*) n
         FROM sales_returns sr WHERE sr.return_date BETWEEN ? AND ? ${cRet}`,
      pRet
    );
    const [bill] = await query<any>(
      `SELECT COALESCE(SUM(b.total),0) gross, COALESCE(SUM(b.subtotal - b.discount_value),0) net_ex_gst,
              COALESCE(SUM(b.tax_total),0) gst, COUNT(*) n
         FROM purchase_invoices b WHERE b.bill_date BETWEEN ? AND ? ${cBill}`,
      pBill
    );
    const [soldCogs] = await query<any>(
      `SELECT COALESCE(SUM(ii.qty * p.cost_price),0) cogs
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
         JOIN products p ON p.id = ii.product_id
        WHERE i.invoice_date BETWEEN ? AND ? ${cInv}`,
      pInv
    );
    const [retCogs] = await query<any>(
      `SELECT COALESCE(SUM(sri.qty * p.cost_price),0) cogs
         FROM sales_return_items sri JOIN sales_returns sr ON sr.id = sri.sales_return_id
         JOIN products p ON p.id = sri.product_id
        WHERE sr.return_date BETWEEN ? AND ? ${cRet}`,
      pRet
    );

    const cLed = companyId ? "AND company_id = ?" : "";
    const pLed: any[] = companyId ? [from, to, companyId] : [from, to];
    const [pay] = await query<any>(
      `SELECT COALESCE(SUM(credit),0) received
         FROM ledger_entries
        WHERE party_type='client' AND source_type IN ('receipt','payment')
          AND entry_date BETWEEN ? AND ? ${cLed}`,
      pLed
    );

    const netSales = r2(Number(inv.net_ex_gst) - Number(ret.net_ex_gst));
    const purchases = r2(bill.net_ex_gst);
    const cogs = r2(Number(soldCogs.cogs) - Number(retCogs.cogs));
    const grossProfit = r2(netSales - cogs);

    res.json({
      window: { from, to, company_id: companyId },
      income: {
        sales_ex_gst: r2(inv.net_ex_gst),
        sales_count: Number(inv.n),
        sales_gross: r2(inv.gross),
        gst_output: r2(inv.gst),
      },
      spend: {
        purchases_ex_gst: purchases,
        purchase_count: Number(bill.n),
        purchases_gross: r2(bill.gross),
        gst_input: r2(bill.gst),
        returns_ex_gst: r2(ret.net_ex_gst),
        returns_count: Number(ret.n),
        returns_gross: r2(ret.gross),
        cogs,
      },
      net_sales: netSales,
      gross_profit: grossProfit,
      gross_margin_pct: netSales > 0 ? r2((grossProfit / netSales) * 100) : 0,
      net_gst_payable: r2(Number(inv.gst) - Number(ret.gst) - Number(bill.gst)),
      payments_received: r2(pay.received),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/by-product", async (req, res, next) => {
  try {
    const { from, to, companyId } = win(req);
    const cInv = companyId ? "AND i.company_id = ?" : "";
    const cRet = companyId ? "AND sr.company_id = ?" : "";
    const cBill = companyId ? "AND b.company_id = ?" : "";
    const pInv: any[] = companyId ? [from, to, companyId] : [from, to];
    const pRet: any[] = companyId ? [from, to, companyId] : [from, to];
    const pBill: any[] = companyId ? [from, to, companyId] : [from, to];

    const sold = await query<any>(
      `SELECT ii.description AS name, COALESCE(p.cost_price,0) cost,
              SUM(ii.qty) qty, SUM(ii.amount) revenue
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
         LEFT JOIN products p ON p.id = ii.product_id
        WHERE i.invoice_date BETWEEN ? AND ? ${cInv}
        GROUP BY ii.description, p.cost_price`,
      pInv
    );
    const returned = await query<any>(
      `SELECT sri.description AS name, SUM(sri.qty) qty, SUM(sri.amount) value
         FROM sales_return_items sri JOIN sales_returns sr ON sr.id = sri.sales_return_id
        WHERE sr.return_date BETWEEN ? AND ? ${cRet}
        GROUP BY sri.description`,
      pRet
    );
    const bought = await query<any>(
      `SELECT bi.description AS name, SUM(bi.qty) qty, SUM(bi.amount) spend
         FROM purchase_invoice_items bi JOIN purchase_invoices b ON b.id = bi.purchase_invoice_id
        WHERE b.bill_date BETWEEN ? AND ? ${cBill}
        GROUP BY bi.description`,
      pBill
    );

    const retMap = new Map(returned.map((x) => [x.name, x]));
    const buyMap = new Map(bought.map((x) => [x.name, x]));
    const names = new Set<string>([
      ...sold.map((x) => x.name),
      ...returned.map((x) => x.name),
      ...bought.map((x) => x.name),
    ]);

    const rows = [...names].map((name) => {
      const s = sold.find((x) => x.name === name);
      const rt = retMap.get(name);
      const by = buyMap.get(name);
      const qtySold = Number(s?.qty || 0);
      const revenue = r2(s?.revenue || 0);
      const retVal = r2(rt?.value || 0);
      const retQty = Number(rt?.qty || 0);
      const cost = Number(s?.cost || 0);
      const cogs = r2(cost * (qtySold - retQty));
      const netRevenue = r2(revenue - retVal);
      return {
        name,
        qty_sold: qtySold,
        revenue,
        qty_returned: retQty,
        return_value: retVal,
        net_revenue: netRevenue,
        cost_price: cost,
        cogs,
        profit: r2(netRevenue - cogs),
        margin_pct: netRevenue > 0 ? r2(((netRevenue - cogs) / netRevenue) * 100) : 0,
        qty_bought: Number(by?.qty || 0),
        purchase_spend: r2(by?.spend || 0),
      };
    });
    rows.sort((a, b) => b.net_revenue - a.net_revenue);
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

router.get("/by-client", async (req, res, next) => {
  try {
    const { from, to, companyId } = win(req);
    const cInv = companyId ? "AND i.company_id = ?" : "";
    const cRet = companyId ? "AND sr.company_id = ?" : "";
    const cLed = companyId ? "AND le.company_id = ?" : "";
    const pInv: any[] = companyId ? [from, to, companyId] : [from, to];
    const pRet: any[] = companyId ? [from, to, companyId] : [from, to];
    const pLed: any[] = companyId ? [from, to, companyId] : [from, to];

    const sales = await query<any>(
      `SELECT i.client_id, cl.name, COUNT(*) n,
              COALESCE(SUM(i.subtotal - i.discount_value),0) net_ex_gst,
              COALESCE(SUM(i.total),0) gross,
              COALESCE(SUM(
                (SELECT COALESCE(SUM(ii.qty * p.cost_price),0)
                   FROM invoice_items ii JOIN products p ON p.id = ii.product_id
                  WHERE ii.invoice_id = i.id)
              ),0) cogs
         FROM invoices i
         LEFT JOIN clients cl ON cl.id = i.client_id
        WHERE i.invoice_date BETWEEN ? AND ? ${cInv}
        GROUP BY i.client_id, cl.name`,
      pInv
    );
    const returns = await query<any>(
      `SELECT sr.client_id, COALESCE(SUM(sr.subtotal),0) ret_ex_gst,
              COALESCE(SUM(sr.total),0) ret_gross,
              COALESCE(SUM(
                (SELECT COALESCE(SUM(sri.qty * p.cost_price),0)
                   FROM sales_return_items sri JOIN products p ON p.id = sri.product_id
                  WHERE sri.sales_return_id = sr.id)
              ),0) ret_cogs, COUNT(*) n
         FROM sales_returns sr
        WHERE sr.return_date BETWEEN ? AND ? ${cRet}
        GROUP BY sr.client_id`,
      pRet
    );
    const pays = await query<any>(
      `SELECT le.party_id AS client_id, COALESCE(SUM(le.credit),0) received
         FROM ledger_entries le
        WHERE le.party_type='client' AND le.source_type IN ('receipt','payment')
          AND le.entry_date BETWEEN ? AND ? ${cLed}
        GROUP BY le.party_id`,
      pLed
    );
    const retMap = new Map(returns.map((x) => [x.client_id, x]));
    const payMap = new Map(pays.map((x) => [x.client_id, x]));

    const rows = sales.map((s) => {
      const rt = retMap.get(s.client_id);
      const netRev = r2(Number(s.net_ex_gst) - Number(rt?.ret_ex_gst || 0));
      const cogs = r2(Number(s.cogs) - Number(rt?.ret_cogs || 0));
      return {
        client_id: s.client_id,
        name: s.name || "—",
        invoice_count: Number(s.n),
        billed_gross: r2(s.gross),
        returns_gross: r2(rt?.ret_gross || 0),
        return_count: Number(rt?.n || 0),
        received: r2(payMap.get(s.client_id)?.received || 0),
        net_revenue: netRev,
        cogs,
        profit: r2(netRev - cogs),
        margin_pct: netRev > 0 ? r2(((netRev - cogs) / netRev) * 100) : 0,
      };
    });
    rows.sort((a, b) => b.net_revenue - a.net_revenue);
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

// ---- drill-down: one product ----
router.get("/product", async (req, res, next) => {
  try {
    const { from, to, companyId } = win(req);
    const name = String(req.query.name || "");
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const cInv = companyId ? "AND i.company_id = ?" : "";
    const cRet = companyId ? "AND sr.company_id = ?" : "";
    const cBill = companyId ? "AND b.company_id = ?" : "";
    const pInv: any[] = companyId ? [name, from, to, companyId] : [name, from, to];
    const pRet: any[] = companyId ? [name, from, to, companyId] : [name, from, to];
    const pBill: any[] = companyId ? [name, from, to, companyId] : [name, from, to];

    // buyers (grouped by client) with per-client qty/value/profit
    const buyers = await query<any>(
      `SELECT i.client_id, cl.name AS client_name,
              SUM(ii.qty) qty, SUM(ii.amount) revenue,
              SUM(ii.qty * COALESCE(p.cost_price,0)) cogs,
              COUNT(DISTINCT i.id) invoice_count
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         LEFT JOIN clients cl ON cl.id = i.client_id
         LEFT JOIN products p ON p.id = ii.product_id
        WHERE ii.description = ? AND i.invoice_date BETWEEN ? AND ? ${cInv}
        GROUP BY i.client_id, cl.name
        ORDER BY revenue DESC`,
      pInv
    );

    // every sale line
    const saleLines = await query<any>(
      `SELECT i.id AS invoice_id, i.number, i.invoice_date AS date, cl.name AS client_name,
              ii.qty, ii.rate, ii.amount
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         LEFT JOIN clients cl ON cl.id = i.client_id
        WHERE ii.description = ? AND i.invoice_date BETWEEN ? AND ? ${cInv}
        ORDER BY i.invoice_date DESC, i.id DESC`,
      pInv
    );

    // returns of this product
    const returnLines = await query<any>(
      `SELECT sr.id AS return_id, sr.number, sr.return_date AS date, sr.reason, sr.restock,
              cl.name AS client_name, sri.qty, sri.rate, sri.amount
         FROM sales_return_items sri
         JOIN sales_returns sr ON sr.id = sri.sales_return_id
         LEFT JOIN clients cl ON cl.id = sr.client_id
        WHERE sri.description = ? AND sr.return_date BETWEEN ? AND ? ${cRet}
        ORDER BY sr.return_date DESC, sr.id DESC`,
      pRet
    );

    // purchases of this product from suppliers
    const purchaseLines = await query<any>(
      `SELECT b.id AS bill_id, b.number, b.bill_date AS date, s.name AS supplier_name,
              bi.qty, bi.rate, bi.amount
         FROM purchase_invoice_items bi
         JOIN purchase_invoices b ON b.id = bi.purchase_invoice_id
         LEFT JOIN suppliers s ON s.id = b.supplier_id
        WHERE bi.description = ? AND b.bill_date BETWEEN ? AND ? ${cBill}
        ORDER BY b.bill_date DESC, b.id DESC`,
      pBill
    );

    const sold = {
      qty: saleLines.reduce((s, l) => s + Number(l.qty), 0),
      value: r2(saleLines.reduce((s, l) => s + Number(l.amount), 0)),
    };
    const returned = {
      qty: returnLines.reduce((s, l) => s + Number(l.qty), 0),
      value: r2(returnLines.reduce((s, l) => s + Number(l.amount), 0)),
    };
    const bought = {
      qty: purchaseLines.reduce((s, l) => s + Number(l.qty), 0),
      value: r2(purchaseLines.reduce((s, l) => s + Number(l.amount), 0)),
    };
    const netRevenue = r2(sold.value - returned.value);
    const cogs = r2(buyers.reduce((s, b) => s + Number(b.cogs), 0));

    res.json({
      name,
      totals: {
        sold,
        returned,
        bought,
        net_revenue: netRevenue,
        cogs,
        profit: r2(netRevenue - cogs),
      },
      buyers: buyers.map((b) => ({
        client_id: b.client_id,
        client_name: b.client_name || "—",
        qty: Number(b.qty),
        revenue: r2(b.revenue),
        cogs: r2(b.cogs),
        profit: r2(Number(b.revenue) - Number(b.cogs)),
        invoice_count: Number(b.invoice_count),
      })),
      sale_lines: saleLines,
      return_lines: returnLines,
      purchase_lines: purchaseLines,
    });
  } catch (err) {
    next(err);
  }
});

// ---- drill-down: one client ----
router.get("/client/:id", async (req, res, next) => {
  try {
    const { from, to, companyId } = win(req);
    const clientId = Number(req.params.id);
    const cInv = companyId ? "AND i.company_id = ?" : "";
    const cRet = companyId ? "AND sr.company_id = ?" : "";
    const pInv: any[] = companyId ? [clientId, from, to, companyId] : [clientId, from, to];
    const pRet: any[] = companyId ? [clientId, from, to, companyId] : [clientId, from, to];

    const [client] = await query<any>("SELECT id, name, phone FROM clients WHERE id = ?", [clientId]);

    const invoices = await query<any>(
      `SELECT i.id, i.number, i.invoice_date AS date, i.total, i.amount_paid,
              (i.total - i.amount_paid) AS balance, i.payment_status,
              (SELECT COALESCE(SUM(ii.qty * COALESCE(p.cost_price,0)),0)
                 FROM invoice_items ii LEFT JOIN products p ON p.id = ii.product_id
                WHERE ii.invoice_id = i.id) AS cogs,
              (i.subtotal - i.discount_value) AS net_ex_gst
         FROM invoices i
        WHERE i.client_id = ? AND i.invoice_date BETWEEN ? AND ? ${cInv}
        ORDER BY i.invoice_date DESC, i.id DESC`,
      pInv
    );

    const returns = await query<any>(
      `SELECT sr.id, sr.number, sr.return_date AS date, sr.reason, sr.restock, sr.total,
              sr.subtotal AS net_ex_gst,
              (SELECT COALESCE(SUM(sri.qty * COALESCE(p.cost_price,0)),0)
                 FROM sales_return_items sri LEFT JOIN products p ON p.id = sri.product_id
                WHERE sri.sales_return_id = sr.id) AS cogs
         FROM sales_returns sr
        WHERE sr.client_id = ? AND sr.return_date BETWEEN ? AND ? ${cRet}
        ORDER BY sr.return_date DESC, sr.id DESC`,
      pRet
    );

    // products bought by this client (net of returns)
    const soldByProd = await query<any>(
      `SELECT ii.description AS name, SUM(ii.qty) qty, SUM(ii.amount) revenue,
              SUM(ii.qty * COALESCE(p.cost_price,0)) cogs
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
         LEFT JOIN products p ON p.id = ii.product_id
        WHERE i.client_id = ? AND i.invoice_date BETWEEN ? AND ? ${cInv}
        GROUP BY ii.description`,
      pInv
    );
    const retByProd = await query<any>(
      `SELECT sri.description AS name, SUM(sri.qty) qty, SUM(sri.amount) value
         FROM sales_return_items sri JOIN sales_returns sr ON sr.id = sri.sales_return_id
        WHERE sr.client_id = ? AND sr.return_date BETWEEN ? AND ? ${cRet}
        GROUP BY sri.description`,
      pRet
    );
    const retMap = new Map(retByProd.map((x) => [x.name, x]));
    const products = soldByProd
      .map((s) => {
        const rt = retMap.get(s.name);
        const netRev = r2(Number(s.revenue) - Number(rt?.value || 0));
        const cogs = r2(s.cogs);
        return {
          name: s.name,
          qty: Number(s.qty),
          revenue: r2(s.revenue),
          returned_qty: Number(rt?.qty || 0),
          returned_value: r2(rt?.value || 0),
          net_revenue: netRev,
          cogs,
          profit: r2(netRev - cogs),
        };
      })
      .sort((a, b) => b.net_revenue - a.net_revenue);

    const totalRev = r2(invoices.reduce((s: number, i: any) => s + Number(i.net_ex_gst), 0));
    const totalRet = r2(returns.reduce((s: number, i: any) => s + Number(i.net_ex_gst), 0));
    const totalCogs = r2(
      invoices.reduce((s: number, i: any) => s + Number(i.cogs), 0) -
        returns.reduce((s: number, i: any) => s + Number(i.cogs), 0)
    );
    const netRevenue = r2(totalRev - totalRet);

    res.json({
      client: client || { id: clientId, name: "—" },
      totals: {
        invoice_count: invoices.length,
        return_count: returns.length,
        sales_ex_gst: totalRev,
        returns_ex_gst: totalRet,
        net_revenue: netRevenue,
        cogs: totalCogs,
        profit: r2(netRevenue - totalCogs),
        margin_pct: netRevenue > 0 ? r2(((netRevenue - totalCogs) / netRevenue) * 100) : 0,
      },
      invoices: invoices.map((i: any) => ({
        ...i,
        profit: r2(Number(i.net_ex_gst) - Number(i.cogs)),
      })),
      returns,
      products,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/by-supplier", async (req, res, next) => {
  try {
    const { from, to, companyId } = win(req);
    const cBill = companyId ? "AND b.company_id = ?" : "";
    const pBill: any[] = companyId ? [from, to, companyId] : [from, to];

    const rows = await query<any>(
      `SELECT b.supplier_id, s.name, COUNT(*) bill_count,
              COALESCE(SUM(b.total),0) purchased_gross,
              COALESCE(SUM(b.subtotal - b.discount_value),0) purchased_ex_gst,
              COALESCE(SUM(b.amount_paid),0) paid,
              COALESCE(SUM(b.total - b.amount_paid),0) outstanding
         FROM purchase_invoices b
         LEFT JOIN suppliers s ON s.id = b.supplier_id
        WHERE b.bill_date BETWEEN ? AND ? ${cBill}
        GROUP BY b.supplier_id, s.name
        ORDER BY purchased_gross DESC`,
      pBill
    );
    res.json({
      rows: rows.map((x) => ({
        supplier_id: x.supplier_id,
        name: x.name || "—",
        bill_count: Number(x.bill_count),
        purchased_gross: r2(x.purchased_gross),
        purchased_ex_gst: r2(x.purchased_ex_gst),
        paid: r2(x.paid),
        outstanding: r2(x.outstanding),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/by-date", async (req, res, next) => {
  try {
    const { from, to, companyId } = win(req);
    const bucket = req.query.bucket === "month" ? "month" : "day";
    const fmt = bucket === "month" ? "%Y-%m" : "%Y-%m-%d";
    const cInv = companyId ? "AND i.company_id = ?" : "";
    const cRet = companyId ? "AND sr.company_id = ?" : "";
    const cBill = companyId ? "AND b.company_id = ?" : "";
    const pInv: any[] = companyId ? [fmt, from, to, companyId] : [fmt, from, to];
    const pRet: any[] = companyId ? [fmt, from, to, companyId] : [fmt, from, to];
    const pBill: any[] = companyId ? [fmt, from, to, companyId] : [fmt, from, to];

    const sales = await query<any>(
      `SELECT DATE_FORMAT(i.invoice_date, ?) k,
              COALESCE(SUM(i.subtotal - i.discount_value),0) sales_ex_gst,
              COALESCE(SUM(
                (SELECT COALESCE(SUM(ii.qty * p.cost_price),0)
                   FROM invoice_items ii JOIN products p ON p.id = ii.product_id
                  WHERE ii.invoice_id = i.id)
              ),0) cogs
         FROM invoices i
        WHERE i.invoice_date BETWEEN ? AND ? ${cInv}
        GROUP BY k`,
      pInv
    );
    const rets = await query<any>(
      `SELECT DATE_FORMAT(sr.return_date, ?) k,
              COALESCE(SUM(sr.subtotal),0) ret_ex_gst,
              COALESCE(SUM(
                (SELECT COALESCE(SUM(sri.qty * p.cost_price),0)
                   FROM sales_return_items sri JOIN products p ON p.id = sri.product_id
                  WHERE sri.sales_return_id = sr.id)
              ),0) ret_cogs
         FROM sales_returns sr
        WHERE sr.return_date BETWEEN ? AND ? ${cRet}
        GROUP BY k`,
      pRet
    );
    const buys = await query<any>(
      `SELECT DATE_FORMAT(b.bill_date, ?) k,
              COALESCE(SUM(b.subtotal - b.discount_value),0) purchases_ex_gst
         FROM purchase_invoices b
        WHERE b.bill_date BETWEEN ? AND ? ${cBill}
        GROUP BY k`,
      pBill
    );

    const retMap = new Map(rets.map((x) => [x.k, x]));
    const buyMap = new Map(buys.map((x) => [x.k, x]));
    const keys = new Set<string>([
      ...sales.map((x) => x.k),
      ...rets.map((x) => x.k),
      ...buys.map((x) => x.k),
    ]);
    const rows = [...keys]
      .sort()
      .map((k) => {
        const s = sales.find((x) => x.k === k);
        const rt = retMap.get(k);
        const by = buyMap.get(k);
        const netSales = r2(Number(s?.sales_ex_gst || 0) - Number(rt?.ret_ex_gst || 0));
        const cogs = r2(Number(s?.cogs || 0) - Number(rt?.ret_cogs || 0));
        return {
          period: k,
          sales: r2(s?.sales_ex_gst || 0),
          returns: r2(rt?.ret_ex_gst || 0),
          purchases: r2(by?.purchases_ex_gst || 0),
          net_sales: netSales,
          cogs,
          gross_profit: r2(netSales - cogs),
        };
      });
    res.json({ bucket, rows });
  } catch (err) {
    next(err);
  }
});

export default router;
