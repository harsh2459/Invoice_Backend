/**
 * Collator P&L + GST — port of Drogon `routes/pnl.py`.
 *
 * `/summary` blends: marketplace revenue (sales − returns) − platform fees
 * (col_fee_invoices) = gross_profit; then bank-transaction keyword classification
 * splits debits into salary / logistics / interest / other → ebitda → net_profit.
 * (Bank-derived figures are ₹0 until bank import is enabled — Phase D.)
 *
 * `/gst-summary`: output tax collected (Amazon total_tax_amount + Flipkart
 * igst+cgst+sgst + Meesho tax_amount) vs ITC from fee invoices → net payable.
 *
 * Filters: year / month / company_id. Amazon+Flipkart+fee-invoices+bank use
 * data_year/data_month; Meesho uses financial_year/month_number.
 */
import { Router } from "express";
import { query } from "../../db";

const router = Router();
const r2 = (n: unknown) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const r1 = (n: unknown) => Math.round((Number(n || 0) + Number.EPSILON) * 10) / 10;

const INCOME_KEYWORDS = [
  "amazon seller", "flipkart internet", "razorpay", "cashfree",
  "paytm", "neft cr", "internal ac for intermedi", "meesho", "shopify",
];

function dataFilter(q: any, extra: string[], params: any[]) {
  if (q.year) {
    extra.push("data_year = ?");
    params.push(Number(q.year));
  }
  if (q.month) {
    extra.push("data_month = ?");
    params.push(Number(q.month));
  }
  if (q.company_id) {
    extra.push("company_id = ?");
    params.push(Number(q.company_id));
  }
}
function msFilter(q: any, extra: string[], params: any[]) {
  if (q.year) {
    extra.push("financial_year = ?");
    params.push(Number(q.year));
  }
  if (q.month) {
    extra.push("month_number = ?");
    params.push(Number(q.month));
  }
  if (q.company_id) {
    extra.push("company_id = ?");
    params.push(Number(q.company_id));
  }
}

async function scalar(sql: string, params: any[]): Promise<number> {
  const rows = await query<{ v: number }>(sql, params);
  return Number(rows[0]?.v || 0);
}

// ---- revenue block (shared by /summary and used to compute totals) ----

async function revenueBlock(q: any) {
  // Amazon
  const amzGW: string[] = ["transaction_type = 'Shipment'"];
  const amzGP: any[] = [];
  dataFilter(q, amzGW, amzGP);
  const amz_gross = await scalar(
    `SELECT COALESCE(SUM(invoice_amount),0) v FROM col_amazon_mtr WHERE ${amzGW.join(" AND ")}`,
    amzGP
  );
  const amzRW: string[] = ["transaction_type IN ('Refund','FreeReplacement')"];
  const amzRP: any[] = [];
  dataFilter(q, amzRW, amzRP);
  const amz_returns = Math.abs(
    await scalar(
      `SELECT COALESCE(SUM(invoice_amount),0) v FROM col_amazon_mtr WHERE ${amzRW.join(" AND ")}`,
      amzRP
    )
  );
  const amzOW: string[] = ["transaction_type = 'Shipment'"];
  const amzOP: any[] = [];
  dataFilter(q, amzOW, amzOP);
  const amz_orders = await scalar(
    `SELECT COUNT(*) v FROM col_amazon_mtr WHERE ${amzOW.join(" AND ")}`,
    amzOP
  );

  // Flipkart
  const fkGW: string[] = ["event_type LIKE '%sale%'"];
  const fkGP: any[] = [];
  dataFilter(q, fkGW, fkGP);
  const fk_gross = await scalar(
    `SELECT COALESCE(SUM(invoice_amount),0) v FROM col_flipkart_sales WHERE ${fkGW.join(" AND ")}`,
    fkGP
  );
  const fkRW: string[] = ["event_type LIKE '%return%'"];
  const fkRP: any[] = [];
  dataFilter(q, fkRW, fkRP);
  const fk_returns = Math.abs(
    await scalar(
      `SELECT COALESCE(SUM(invoice_amount),0) v FROM col_flipkart_sales WHERE ${fkRW.join(" AND ")}`,
      fkRP
    )
  );
  const fkOW: string[] = ["event_type LIKE '%sale%'"];
  const fkOP: any[] = [];
  dataFilter(q, fkOW, fkOP);
  const fk_orders = await scalar(
    `SELECT COUNT(*) v FROM col_flipkart_sales WHERE ${fkOW.join(" AND ")}`,
    fkOP
  );

  // Meesho
  const msGW: string[] = ["1=1"];
  const msGP: any[] = [];
  msFilter(q, msGW, msGP);
  const ms_gross = await scalar(
    `SELECT COALESCE(SUM(total_invoice_value),0) v FROM col_meesho_sales WHERE ${msGW.join(" AND ")}`,
    msGP
  );
  const msRW: string[] = ["1=1"];
  const msRP: any[] = [];
  msFilter(q, msRW, msRP);
  const ms_returns = Math.abs(
    await scalar(
      `SELECT COALESCE(SUM(total_invoice_value),0) v FROM col_meesho_returns WHERE ${msRW.join(
        " AND "
      )}`,
      msRP
    )
  );
  const msOW: string[] = ["1=1"];
  const msOP: any[] = [];
  msFilter(q, msOW, msOP);
  const ms_orders = await scalar(
    `SELECT COUNT(*) v FROM col_meesho_sales WHERE ${msOW.join(" AND ")}`,
    msOP
  );

  const amazon_net = r2(amz_gross - amz_returns);
  const flipkart_net = r2(fk_gross - fk_returns);
  const meesho_net = r2(ms_gross - ms_returns);

  return {
    amazon: { gross: r2(amz_gross), returns: r2(amz_returns), net: amazon_net, orders: amz_orders },
    flipkart: { gross: r2(fk_gross), returns: r2(fk_returns), net: flipkart_net, orders: fk_orders },
    meesho: { gross: r2(ms_gross), returns: r2(ms_returns), net: meesho_net, orders: ms_orders },
    total: r2(amazon_net + flipkart_net + meesho_net),
  };
}

// ---- /summary ----

router.get("/summary", async (req, res, next) => {
  try {
    const q = req.query;
    const revenue = await revenueBlock(q);

    // platform fees from col_fee_invoices
    const feeW: string[] = ["1=1"];
    const feeP: any[] = [];
    dataFilter(q, feeW, feeP);
    const feeRow = await query<any>(
      `SELECT COALESCE(SUM(taxable_amount),0) fees,
              COALESCE(SUM(igst_amount),0) igst,
              COALESCE(SUM(total_amount),0) total
       FROM col_fee_invoices WHERE ${feeW.join(" AND ")}`,
      feeP
    );
    const platform_fees = r2(feeRow[0]?.fees);
    const platform_fees_gst = r2(feeRow[0]?.igst);
    const platform_fees_total = r2(feeRow[0]?.total);

    // bank keyword classification
    const bkW: string[] = ["1=1"];
    const bkP: any[] = [];
    dataFilter(q, bkW, bkP);
    const bankRows = await query<{ description: string; debit: number; credit: number }>(
      `SELECT description, debit, credit FROM col_bank_txns WHERE ${bkW.join(" AND ")}`,
      bkP
    );

    let bank_income = 0,
      bank_salary = 0,
      bank_logistics = 0,
      bank_other = 0,
      bank_interest = 0,
      bank_total_credit = 0,
      bank_total_debit = 0;
    for (const row of bankRows) {
      const desc = (row.description || "").toLowerCase();
      bank_total_credit += Number(row.credit || 0);
      bank_total_debit += Number(row.debit || 0);
      if (Number(row.credit) > 0 && INCOME_KEYWORDS.some((k) => desc.includes(k)))
        bank_income += Number(row.credit);
      if (Number(row.debit) > 0) {
        if (desc.includes("salary") || desc.includes("wfh") || desc.includes("staff"))
          bank_salary += Number(row.debit);
        else if (desc.includes("shiprocket") || desc.includes("ship"))
          bank_logistics += Number(row.debit);
        else if (desc.includes("debit interest") || desc.includes("interest capitalized"))
          bank_interest += Number(row.debit);
        else bank_other += Number(row.debit);
      }
    }

    const gross_profit = r2(revenue.total - platform_fees);
    const operating_expenses = r2(bank_salary + bank_logistics + bank_other);
    const ebitda = r2(gross_profit - operating_expenses);
    const net_profit = r2(ebitda - bank_interest);
    const net_margin = revenue.total ? r1((net_profit / revenue.total) * 100) : 0;

    res.json({
      revenue,
      platform_fees: {
        taxable: platform_fees,
        gst: platform_fees_gst,
        total: platform_fees_total,
      },
      gross_profit,
      expenses: {
        salary: r2(bank_salary),
        logistics: r2(bank_logistics),
        interest: r2(bank_interest),
        other: r2(bank_other),
        total: r2(bank_salary + bank_logistics + bank_other + bank_interest),
      },
      ebitda,
      net_profit,
      net_margin,
      bank: {
        total_credit: r2(bank_total_credit),
        total_debit: r2(bank_total_debit),
        marketplace_income: r2(bank_income),
        transactions: bankRows.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---- /gst-summary ----

router.get("/gst-summary", async (req, res, next) => {
  try {
    const q = req.query;

    const amzW: string[] = ["transaction_type = 'Shipment'", "total_tax_amount IS NOT NULL"];
    const amzP: any[] = [];
    dataFilter(q, amzW, amzP);
    const amz_gst = await scalar(
      `SELECT COALESCE(SUM(total_tax_amount),0) v FROM col_amazon_mtr WHERE ${amzW.join(" AND ")}`,
      amzP
    );

    const fkW: string[] = ["event_type LIKE '%sale%'"];
    const fkP: any[] = [];
    dataFilter(q, fkW, fkP);
    const fk_gst = await scalar(
      `SELECT COALESCE(SUM(COALESCE(igst_amount,0) + COALESCE(cgst_amount,0) + COALESCE(sgst_amount,0)),0) v
       FROM col_flipkart_sales WHERE ${fkW.join(" AND ")}`,
      fkP
    );

    const msW: string[] = ["tax_amount IS NOT NULL"];
    const msP: any[] = [];
    msFilter(q, msW, msP);
    const ms_tax = await scalar(
      `SELECT COALESCE(SUM(tax_amount),0) v FROM col_meesho_sales WHERE ${msW.join(" AND ")}`,
      msP
    );

    const total_gst_collected = r2(amz_gst + fk_gst + ms_tax);

    const itcW: string[] = ["1=1"];
    const itcP: any[] = [];
    dataFilter(q, itcW, itcP);
    const itcRow = await query<any>(
      `SELECT COALESCE(SUM(igst_amount),0) igst,
              COALESCE(SUM(cgst_amount),0) cgst,
              COALESCE(SUM(sgst_amount),0) sgst
       FROM col_fee_invoices WHERE ${itcW.join(" AND ")}`,
      itcP
    );
    const itc_igst = r2(itcRow[0]?.igst);
    const itc_cgst = r2(itcRow[0]?.cgst);
    const itc_sgst = r2(itcRow[0]?.sgst);
    const total_itc = r2(itc_igst + itc_cgst + itc_sgst);

    res.json({
      gst_collected: {
        amazon_igst: r2(amz_gst),
        flipkart_tax: r2(fk_gst),
        meesho_tax: r2(ms_tax),
        total: total_gst_collected,
      },
      itc: { igst: itc_igst, cgst: itc_cgst, sgst: itc_sgst, total: total_itc },
      net_gst_payable: r2(total_gst_collected - total_itc),
      note: "Positive = amount payable to GST; Negative = excess ITC",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
