/**
 * Collator dashboard — port of Drogon `routes/dashboard.py`. All SQL sums ported
 * verbatim. Amazon/Flipkart filter on data_year/data_month; Meesho on
 * financial_year/month_number.
 */
import { Router } from "express";
import { query } from "../../db";

const router = Router();
const r2 = (n: unknown) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

function amzWhere(q: any, base: string[], params: any[]) {
  if (q.year) {
    base.push("data_year = ?");
    params.push(Number(q.year));
  }
  if (q.month) {
    base.push("data_month = ?");
    params.push(Number(q.month));
  }
  if (q.company_id) {
    base.push("company_id = ?");
    params.push(Number(q.company_id));
  }
}
function msWhere(q: any, base: string[], params: any[]) {
  if (q.year) {
    base.push("financial_year = ?");
    params.push(Number(q.year));
  }
  if (q.month) {
    base.push("month_number = ?");
    params.push(Number(q.month));
  }
  if (q.company_id) {
    base.push("company_id = ?");
    params.push(Number(q.company_id));
  }
}
const sum1 = async (sql: string, params: any[]) => {
  const rows = await query<{ v: number }>(sql, params);
  return Number(rows[0]?.v || 0);
};

async function computeSummary(q: any) {
  const amzG: string[] = ["transaction_type = 'Shipment'"];
  const amzGP: any[] = [];
  amzWhere(q, amzG, amzGP);
  const amazon_gross = await sum1(
    `SELECT COALESCE(SUM(invoice_amount),0) v FROM col_amazon_mtr WHERE ${amzG.join(" AND ")}`,
    amzGP
  );

  const amzR: string[] = ["transaction_type IN ('Refund','FreeReplacement')"];
  const amzRP: any[] = [];
  amzWhere(q, amzR, amzRP);
  const amazon_returns = Math.abs(
    await sum1(
      `SELECT COALESCE(SUM(invoice_amount),0) v FROM col_amazon_mtr WHERE ${amzR.join(" AND ")}`,
      amzRP
    )
  );

  const amzO: string[] = ["transaction_type = 'Shipment'"];
  const amzOP: any[] = [];
  amzWhere(q, amzO, amzOP);
  const amz_orders = await sum1(
    `SELECT COUNT(*) v FROM col_amazon_mtr WHERE ${amzO.join(" AND ")}`,
    amzOP
  );

  const fkG: string[] = ["event_type LIKE '%sale%'"];
  const fkGP: any[] = [];
  amzWhere(q, fkG, fkGP);
  const flipkart_gross = await sum1(
    `SELECT COALESCE(SUM(invoice_amount),0) v FROM col_flipkart_sales WHERE ${fkG.join(" AND ")}`,
    fkGP
  );

  const fkR: string[] = ["event_type LIKE '%return%'"];
  const fkRP: any[] = [];
  amzWhere(q, fkR, fkRP);
  const flipkart_returns = Math.abs(
    await sum1(
      `SELECT COALESCE(SUM(invoice_amount),0) v FROM col_flipkart_sales WHERE ${fkR.join(" AND ")}`,
      fkRP
    )
  );

  const fkO: string[] = ["event_type LIKE '%sale%'"];
  const fkOP: any[] = [];
  amzWhere(q, fkO, fkOP);
  const fk_orders = await sum1(
    `SELECT COUNT(*) v FROM col_flipkart_sales WHERE ${fkO.join(" AND ")}`,
    fkOP
  );

  const msG: string[] = ["1=1"];
  const msGP: any[] = [];
  msWhere(q, msG, msGP);
  const meesho_gross = await sum1(
    `SELECT COALESCE(SUM(total_invoice_value),0) v FROM col_meesho_sales WHERE ${msG.join(" AND ")}`,
    msGP
  );

  const msR: string[] = ["1=1"];
  const msRP: any[] = [];
  msWhere(q, msR, msRP);
  const meesho_returns = Math.abs(
    await sum1(
      `SELECT COALESCE(SUM(total_invoice_value),0) v FROM col_meesho_returns WHERE ${msR.join(
        " AND "
      )}`,
      msRP
    )
  );

  const msO: string[] = ["1=1"];
  const msOP: any[] = [];
  msWhere(q, msO, msOP);
  const ms_orders = await sum1(
    `SELECT COUNT(*) v FROM col_meesho_sales WHERE ${msO.join(" AND ")}`,
    msOP
  );

  const total_gross = amazon_gross + flipkart_gross + meesho_gross;
  const total_returns = amazon_returns + flipkart_returns + meesho_returns;

  return {
    total_gross: r2(total_gross),
    total_returns: r2(total_returns),
    net_revenue: r2(total_gross - total_returns),
    platforms: {
      amazon: { gross: r2(amazon_gross), returns: r2(amazon_returns), orders: amz_orders },
      flipkart: { gross: r2(flipkart_gross), returns: r2(flipkart_returns), orders: fk_orders },
      meesho: { gross: r2(meesho_gross), returns: r2(meesho_returns), orders: ms_orders },
    },
  };
}

router.get("/summary", async (req, res, next) => {
  try {
    res.json(await computeSummary(req.query));
  } catch (err) {
    next(err);
  }
});

router.get("/platform-share", async (req, res, next) => {
  try {
    const s = await computeSummary(req.query);
    const total = s.total_gross || 1;
    res.json([
      { platform: "Amazon", gross: s.platforms.amazon.gross, share: r2((s.platforms.amazon.gross / total) * 100) },
      { platform: "Flipkart", gross: s.platforms.flipkart.gross, share: r2((s.platforms.flipkart.gross / total) * 100) },
      { platform: "Meesho", gross: s.platforms.meesho.gross, share: r2((s.platforms.meesho.gross / total) * 100) },
    ]);
  } catch (err) {
    next(err);
  }
});

router.get("/monthly-trend", async (req, res, next) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const amzW = ["transaction_type = 'Shipment'", "data_year IS NOT NULL", "data_month IS NOT NULL"];
    const fkW = ["event_type LIKE '%sale%'", "data_year IS NOT NULL", "data_month IS NOT NULL"];
    const msW = ["financial_year IS NOT NULL", "month_number IS NOT NULL"];
    const amzP: any[] = [];
    const fkP: any[] = [];
    const msP: any[] = [];
    if (year) {
      amzW.push("data_year = ?");
      amzP.push(year);
      fkW.push("data_year = ?");
      fkP.push(year);
      msW.push("financial_year = ?");
      msP.push(year);
    }
    const amazon = await query(
      `SELECT data_year AS year, data_month AS month, ROUND(SUM(invoice_amount),2) AS revenue
       FROM col_amazon_mtr WHERE ${amzW.join(" AND ")}
       GROUP BY data_year, data_month ORDER BY data_year, data_month`,
      amzP
    );
    const flipkart = await query(
      `SELECT data_year AS year, data_month AS month, ROUND(SUM(invoice_amount),2) AS revenue
       FROM col_flipkart_sales WHERE ${fkW.join(" AND ")}
       GROUP BY data_year, data_month ORDER BY data_year, data_month`,
      fkP
    );
    const meesho = await query(
      `SELECT financial_year AS year, month_number AS month, ROUND(SUM(total_invoice_value),2) AS revenue
       FROM col_meesho_sales WHERE ${msW.join(" AND ")}
       GROUP BY financial_year, month_number ORDER BY financial_year, month_number`,
      msP
    );
    res.json({ amazon, flipkart, meesho });
  } catch (err) {
    next(err);
  }
});

router.get("/top-skus", async (req, res, next) => {
  try {
    const limit = Math.min(50, Number(req.query.limit) || 10);
    const platform = String(req.query.platform || "amazon");
    const w: string[] = [];
    const p: any[] = [];
    if (req.query.year) {
      p.push(Number(req.query.year));
    }
    if (req.query.month) {
      p.push(Number(req.query.month));
    }
    if (platform === "amazon") {
      const cl = ["transaction_type = 'Shipment'", "sku IS NOT NULL"];
      const pp: any[] = [];
      if (req.query.year) {
        cl.push("data_year = ?");
        pp.push(Number(req.query.year));
      }
      if (req.query.month) {
        cl.push("data_month = ?");
        pp.push(Number(req.query.month));
      }
      const rows = await query(
        `SELECT sku, ROUND(SUM(invoice_amount),2) AS revenue, COUNT(*) AS orders
         FROM col_amazon_mtr WHERE ${cl.join(" AND ")}
         GROUP BY sku ORDER BY SUM(invoice_amount) DESC LIMIT ?`,
        [...pp, limit]
      );
      res.json(rows);
      return;
    }
    if (platform === "flipkart") {
      const cl = ["sku IS NOT NULL"];
      const pp: any[] = [];
      if (req.query.year) {
        cl.push("data_year = ?");
        pp.push(Number(req.query.year));
      }
      if (req.query.month) {
        cl.push("data_month = ?");
        pp.push(Number(req.query.month));
      }
      const rows = await query(
        `SELECT sku, ROUND(SUM(invoice_amount),2) AS revenue, COUNT(*) AS orders
         FROM col_flipkart_sales WHERE ${cl.join(" AND ")}
         GROUP BY sku ORDER BY SUM(invoice_amount) DESC LIMIT ?`,
        [...pp, limit]
      );
      res.json(rows);
      return;
    }
    if (platform === "meesho") {
      const cl = ["sup_name IS NOT NULL"];
      const pp: any[] = [];
      if (req.query.year) {
        cl.push("financial_year = ?");
        pp.push(Number(req.query.year));
      }
      if (req.query.month) {
        cl.push("month_number = ?");
        pp.push(Number(req.query.month));
      }
      const rows = await query(
        `SELECT sup_name AS sku, ROUND(SUM(total_invoice_value),2) AS revenue, COUNT(*) AS orders
         FROM col_meesho_sales WHERE ${cl.join(" AND ")}
         GROUP BY sup_name ORDER BY SUM(total_invoice_value) DESC LIMIT ?`,
        [...pp, limit]
      );
      res.json(rows);
      return;
    }
    void w;
    void p;
    res.json([]);
  } catch (err) {
    next(err);
  }
});

router.get("/bank-summary", async (_req, res, next) => {
  try {
    const agg = await query<any>(
      `SELECT COALESCE(SUM(credit),0) AS total_credit,
              COALESCE(SUM(debit),0) AS total_debit,
              COUNT(*) AS transaction_count
       FROM col_bank_txns`
    );
    const latest = await query<{ balance: number }>(
      "SELECT balance FROM col_bank_txns ORDER BY transaction_date DESC, id DESC LIMIT 1"
    );
    const tc = Number(agg[0]?.total_credit || 0);
    const td = Number(agg[0]?.total_debit || 0);
    res.json({
      total_credit: r2(tc),
      total_debit: r2(td),
      net: r2(tc - td),
      transaction_count: Number(agg[0]?.transaction_count || 0),
      latest_balance: latest[0]?.balance ?? null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
