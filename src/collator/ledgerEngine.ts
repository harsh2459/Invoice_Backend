/**
 * Collator ledger engine — shared helpers for the Tally-style accounting layer.
 * Port of the private functions in Drogon `routes/ledger.py`.
 *
 * All balances are a SINGLE-ENTRY approximation: only the assigned side of each
 * classified bank transaction (col_bank_txns.ledger_head_id) is counted.
 *
 * Sign convention (`signedBalance`):
 *   asset / expense  -> debit - credit   (debit increases)
 *   liability/income -> credit - debit   (credit increases)
 */
import { query, exec } from "../db";

export type Nature = "income" | "expense" | "asset" | "liability";

export function signedBalance(nature: string, debit: number, credit: number): number {
  return nature === "asset" || nature === "expense" ? debit - credit : credit - debit;
}

/** Run every active keyword rule; assign matching, non-manual txns. Returns count. */
export async function applyLedgerRules(): Promise<number> {
  const rules = await query<{ ledger_id: number; keyword: string }>(
    "SELECT ledger_id, keyword FROM col_ledger_rules WHERE active = 1"
  );
  let updated = 0;
  for (const r of rules) {
    const res = await exec(
      "UPDATE col_bank_txns SET ledger_head_id = ? WHERE description LIKE ? AND ledger_manual = 0",
      [r.ledger_id, `%${r.keyword}%`]
    );
    updated += res.affectedRows;
  }
  return updated;
}

const PLATFORM_KEYWORDS: Record<string, string[]> = {
  Amazon: ["amazon seller", "amazon"],
  Flipkart: ["flipkart internet", "flipkart"],
  Meesho: ["meesho"],
};

export async function applyPlatformTags(): Promise<number> {
  let updated = 0;
  for (const [platform, kws] of Object.entries(PLATFORM_KEYWORDS)) {
    for (const kw of kws) {
      const res = await exec(
        "UPDATE col_bank_txns SET platform = ? WHERE description LIKE ? AND platform_manual = 0",
        [platform, `%${kw}%`]
      );
      updated += res.affectedRows;
    }
  }
  return updated;
}

export interface PeriodOpts {
  companyId?: number | null;
  year?: number | null;
  month?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

function periodWhere(o: PeriodOpts, extraStart: string[] = []): { where: string; params: any[] } {
  const w = [...extraStart];
  const p: any[] = [];
  if (o.companyId) {
    w.push("company_id = ?");
    p.push(o.companyId);
  }
  if (o.year) {
    w.push("data_year = ?");
    p.push(o.year);
  }
  if (o.month) {
    w.push("data_month = ?");
    p.push(o.month);
  }
  if (o.dateFrom) {
    w.push("transaction_date >= ?");
    p.push(o.dateFrom);
  }
  if (o.dateTo) {
    w.push("transaction_date <= ?");
    p.push(o.dateTo);
  }
  return { where: w.length ? w.join(" AND ") : "1=1", params: p };
}

export interface LedgerBal {
  credit: number;
  debit: number;
  count: number;
}

/** { ledger_id: {credit, debit, count} } for classified txns in the period. */
export async function ledgerBalances(o: PeriodOpts): Promise<Map<number, LedgerBal>> {
  const { where, params } = periodWhere(o, ["ledger_head_id IS NOT NULL"]);
  const rows = await query<{ ledger_head_id: number; credit: number; debit: number; n: number }>(
    `SELECT ledger_head_id,
            COALESCE(SUM(credit),0) credit,
            COALESCE(SUM(debit),0) debit,
            COUNT(*) n
     FROM col_bank_txns WHERE ${where}
     GROUP BY ledger_head_id`,
    params
  );
  const m = new Map<number, LedgerBal>();
  for (const r of rows)
    m.set(Number(r.ledger_head_id), {
      credit: Number(r.credit),
      debit: Number(r.debit),
      count: Number(r.n),
    });
  return m;
}

export interface LedgerRow {
  id: number;
  name: string;
  group_id: number;
  color: string;
}
export interface GroupRow {
  id: number;
  name: string;
  nature: string;
}

export async function loadLedgersAndGroups(): Promise<{
  ledgers: LedgerRow[];
  groups: Map<number, GroupRow>;
}> {
  const ledgers = await query<LedgerRow>(
    "SELECT id, name, group_id, color FROM col_ledgers ORDER BY name"
  );
  const grpRows = await query<GroupRow>("SELECT id, name, nature FROM col_ledger_groups");
  const groups = new Map<number, GroupRow>(grpRows.map((g) => [g.id, g]));
  return { ledgers, groups };
}

/** Groups (of the given natures) with their rolled-up balance. Every ledger in a
 *  matching group is counted, even with zero activity. */
export async function groupRollup(
  natures: Nature[],
  o: PeriodOpts
): Promise<{ group_id: number; group_name: string; nature: string; total: number; ledger_count: number }[]> {
  const bals = await ledgerBalances({ companyId: o.companyId, year: o.year, month: o.month });
  const { ledgers, groups } = await loadLedgersAndGroups();

  const acc = new Map<number, { group: GroupRow; total: number; count: number }>();
  for (const l of ledgers) {
    const g = groups.get(l.group_id);
    if (!g || !natures.includes(g.nature as Nature)) continue;
    const b = bals.get(l.id) || { credit: 0, debit: 0, count: 0 };
    const signed = signedBalance(g.nature, b.debit, b.credit);
    const e = acc.get(g.id) || { group: g, total: 0, count: 0 };
    e.total += signed;
    e.count += 1;
    acc.set(g.id, e);
  }
  return [...acc.entries()]
    .map(([gid, v]) => ({
      group_id: gid,
      group_name: v.group.name,
      nature: v.group.nature,
      total: round2(v.total),
      ledger_count: v.count,
    }))
    .sort((a, b) => a.group_name.localeCompare(b.group_name));
}

export const round2 = (n: unknown) =>
  Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
