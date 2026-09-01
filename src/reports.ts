import { query } from "./db";

export interface RangeOpts {
  start?: string;
  end?: string;
  employeeId?: number; // when set, scope sales to this employee and treat payments/expenses as empty
  companyId?: number; // when set, scope invoice figures to this company (firm)
}

function dateFilter(
  start?: string,
  end?: string,
  col = "date"
): { clause: string; params: string[] } {
  if (start && end) return { clause: ` AND ${col} >= ? AND ${col} <= ?`, params: [start, end] };
  return { clause: "", params: [] };
}

export async function getSummary(opts: RangeOpts) {
  const { clause, params } = dateFilter(opts.start, opts.end);

  let sales = 0;
  if (opts.employeeId) {
    const rows = await query<any>(
      `SELECT SUM(amount) AS t FROM sales WHERE employee_id = ?${clause}`,
      [opts.employeeId, ...params]
    );
    sales = Number(rows[0]?.t || 0);
  } else {
    const rows = await query<any>(`SELECT SUM(amount) AS t FROM sales WHERE 1=1${clause}`, params);
    sales = Number(rows[0]?.t || 0);
  }

  let payments = 0;
  let expenses = 0;
  let invoiced = 0;
  let invoiceOutstanding = 0;
  if (!opts.employeeId) {
    const pRows = await query<any>(`SELECT SUM(amount) AS t FROM payments WHERE 1=1${clause}`, params);
    const eRows = await query<any>(`SELECT SUM(amount) AS t FROM expenses WHERE 1=1${clause}`, params);
    const iRows = await query<any>(
      `SELECT SUM(total) AS t, SUM(total - amount_paid) AS bal FROM invoices WHERE 1=1${dateFilter(
        opts.start,
        opts.end,
        "invoice_date"
      ).clause}`,
      dateFilter(opts.start, opts.end, "invoice_date").params
    );
    payments = Number(pRows[0]?.t || 0);
    expenses = Number(eRows[0]?.t || 0);
    invoiced = Number(iRows[0]?.t || 0);
    invoiceOutstanding = Number(iRows[0]?.bal || 0);
  }

  return {
    sales,
    payments,
    expenses,
    invoiced,
    invoiceOutstanding,
    net: payments - expenses,
  };
}

export interface PlatformRow {
  platform: string;
  payments: number;
}

// Marketplace payments grouped by platform. Employee sales have no platform.
export async function getByPlatform(opts: RangeOpts): Promise<PlatformRow[]> {
  if (opts.employeeId) return [];
  const { clause, params } = dateFilter(opts.start, opts.end);
  const rows = await query<any>(
    `SELECT platform, SUM(amount) AS t FROM payments WHERE 1=1${clause} GROUP BY platform`,
    params
  );
  return rows
    .map((r) => ({ platform: r.platform, payments: Number(r.t || 0) }))
    .sort((a, b) => b.payments - a.payments);
}

export interface EmployeeRow {
  employee_id: number;
  employee_name: string;
  count: number;
  total: number;
}

export async function getByEmployee(opts: RangeOpts): Promise<EmployeeRow[]> {
  const { clause, params } = dateFilter(opts.start, opts.end);
  let rows: any[];
  if (opts.employeeId) {
    rows = await query<any>(
      `SELECT s.employee_id, u.name AS employee_name, COUNT(*) AS count, SUM(s.amount) AS total
       FROM sales s JOIN users u ON u.id = s.employee_id
       WHERE s.employee_id = ?${clause}
       GROUP BY s.employee_id, u.name
       ORDER BY total DESC`,
      [opts.employeeId, ...params]
    );
  } else {
    rows = await query<any>(
      `SELECT s.employee_id, u.name AS employee_name, COUNT(*) AS count, SUM(s.amount) AS total
       FROM sales s JOIN users u ON u.id = s.employee_id
       WHERE 1=1${clause}
       GROUP BY s.employee_id, u.name
       ORDER BY total DESC`,
      params
    );
  }
  return rows.map((r) => ({
    employee_id: r.employee_id,
    employee_name: r.employee_name,
    count: Number(r.count || 0),
    total: Number(r.total || 0),
  }));
}

export interface InvoiceSummary {
  invoiceCount: number;
  invoicedTotal: number;
  taxTotal: number;
  collected: number;
  outstanding: number;
}

export async function getInvoiceSummary(opts: RangeOpts): Promise<InvoiceSummary> {
  const { clause, params } = dateFilter(opts.start, opts.end, "invoice_date");
  let clause2 = clause;
  const params2 = [...params];
  if (opts.companyId) {
    clause2 += " AND company_id = ?";
    params2.push(String(opts.companyId));
  }
  const rows = await query<any>(
    `SELECT COUNT(*) AS c, SUM(total) AS t, SUM(tax_total) AS tax,
            SUM(amount_paid) AS paid, SUM(total - amount_paid) AS bal
     FROM invoices WHERE 1=1${clause2}`,
    params2
  );
  return {
    invoiceCount: Number(rows[0]?.c || 0),
    invoicedTotal: Number(rows[0]?.t || 0),
    taxTotal: Number(rows[0]?.tax || 0),
    collected: Number(rows[0]?.paid || 0),
    outstanding: Number(rows[0]?.bal || 0),
  };
}

export interface CollectedByBankRow {
  bank_account_id: number | null;
  bank_name: string;
  bank_last4: string | null;
  company_name: string | null;
  payment_count: number;
  collected: number;
}

// Payments grouped by the bank account they were received into. Filtered by the
// payment's date (paid_on) and, when set, the payment's invoice's company.
export async function getCollectedByBank(opts: RangeOpts): Promise<CollectedByBankRow[]> {
  const { clause, params } = dateFilter(opts.start, opts.end, "ip.paid_on");
  let clause2 = clause;
  const params2 = [...params];
  if (opts.companyId) {
    clause2 += " AND i.company_id = ?";
    params2.push(String(opts.companyId));
  }
  const rows = await query<any>(
    `SELECT ba.id AS bank_account_id, ba.name AS bank_name, ba.last4 AS bank_last4,
            co.name AS company_name,
            COUNT(*) AS payment_count, SUM(ip.amount) AS collected
     FROM invoice_payments ip
     JOIN invoices i ON i.id = ip.invoice_id
     LEFT JOIN bank_accounts ba ON ba.id = ip.bank_account_id
     LEFT JOIN companies co ON co.id = ba.company_id
     WHERE 1=1${clause2}
     GROUP BY ba.id, ba.name, ba.last4, co.name
     ORDER BY collected DESC`,
    params2
  );
  return rows.map((r) => ({
    bank_account_id: r.bank_account_id ?? null,
    bank_name: r.bank_name ?? "Unassigned",
    bank_last4: r.bank_last4 ?? null,
    company_name: r.company_name ?? null,
    payment_count: Number(r.payment_count || 0),
    collected: Number(r.collected || 0),
  }));
}

export async function getExpenses(opts: RangeOpts) {
  const { clause, params } = dateFilter(opts.start, opts.end);
  const rows = await query<any>(
    `SELECT * FROM expenses WHERE 1=1${clause} ORDER BY date DESC, id DESC`,
    params
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export interface EmployeeReport {
  employee: { id: number; name: string } | null;
  start?: string;
  end?: string;
  count: number;
  total: number;
  sales: { id: number; date: string; amount: number; notes: string | null }[];
}

export async function getEmployeeReport(
  employeeId: number,
  start?: string,
  end?: string
): Promise<EmployeeReport> {
  const { clause, params } = dateFilter(start, end);
  const users = await query<{ id: number; name: string }>(
    "SELECT id, name FROM users WHERE id = ?",
    [employeeId]
  );
  const sales = await query<any>(
    `SELECT id, date, amount, notes FROM sales WHERE employee_id = ?${clause} ORDER BY date DESC, id DESC`,
    [employeeId, ...params]
  );
  const rows = sales.map((s) => ({
    id: s.id,
    date: s.date,
    amount: Number(s.amount),
    notes: s.notes ?? null,
  }));
  return {
    employee: users[0] ?? null,
    start,
    end,
    count: rows.length,
    total: rows.reduce((sum, r) => sum + r.amount, 0),
    sales: rows,
  };
}
