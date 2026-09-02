/**
 * The single ledger. Every money-moving document posts ONE row via postEntry().
 * A party's balance is always SUM(debit) - SUM(credit).
 *
 *   client  : positive balance = customer owes us
 *   supplier: positive balance = we owe the supplier
 */
import { query } from "./db";
import { round2 } from "./invoiceMath";

interface TxLike {
  query: <R = any>(sql: string, params?: any[]) => Promise<R[]>;
  exec: (sql: string, params?: any[]) => Promise<{ affectedRows: number; insertId?: number }>;
}

export type PartyType = "client" | "supplier";
export type LedgerSource =
  | "invoice"
  | "receipt"
  | "sales_return"
  | "purchase"
  | "payment"
  | "purchase_return"
  | "opening"
  | "adjustment";

export interface LedgerPost {
  partyType: PartyType;
  partyId: number;
  companyId?: number | null;
  date: string; // yyyy-mm-dd
  sourceType: LedgerSource;
  sourceId?: number | null;
  particulars: string;
  ref?: string | null;
  debit?: number;
  credit?: number;
  userId?: number | null;
}

/** Insert one ledger row. Call inside the same transaction as the source doc. */
export async function postEntry(tx: TxLike, p: LedgerPost): Promise<number> {
  const r = await tx.exec(
    `INSERT INTO ledger_entries
       (party_type, party_id, company_id, entry_date, source_type, source_id,
        particulars, ref, debit, credit, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.partyType,
      p.partyId,
      p.companyId ?? null,
      p.date.slice(0, 10),
      p.sourceType,
      p.sourceId ?? null,
      p.particulars,
      p.ref ?? null,
      round2(p.debit || 0),
      round2(p.credit || 0),
      p.userId ?? null,
    ]
  );
  return r.insertId!;
}

/** Remove ledger rows for a source doc (used when a doc is deleted/edited). */
export async function voidEntriesFor(
  tx: TxLike,
  sourceType: LedgerSource,
  sourceId: number
): Promise<void> {
  await tx.exec("DELETE FROM ledger_entries WHERE source_type = ? AND source_id = ?", [
    sourceType,
    sourceId,
  ]);
}

/** Current balance for a party from the ledger. */
export async function partyBalance(
  partyType: PartyType,
  partyId: number,
  opts?: { asOf?: string; runner?: TxLike }
): Promise<number> {
  const run = opts?.runner?.query ?? query;
  const params: any[] = [partyType, partyId];
  let where = "party_type = ? AND party_id = ?";
  if (opts?.asOf) {
    where += " AND entry_date <= ?";
    params.push(opts.asOf.slice(0, 10));
  }
  const rows = await run<{ bal: string | number }>(
    `SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS bal FROM ledger_entries WHERE ${where}`,
    params
  );
  return round2(Number(rows[0]?.bal ?? 0));
}

export interface StatementRow {
  date: string;
  source_type: LedgerSource;
  source_id: number | null;
  ref: string;
  particulars: string; // short, plain type word
  kind_label: string; // "Sales Invoice" | "Payment Received" | "Sales Return" | "Payment"
  debit: number;
  credit: number;
  balance: number;
  /** sub-lines when several entries belong to the same document (combined create) */
  children?: Omit<StatementRow, "children" | "balance">[];
}

const KIND_LABEL: Record<string, string> = {
  invoice: "Sales Invoice",
  receipt: "Payment Received",
  sales_return: "Sales Return",
  payment: "Payment",
  purchase: "Purchase Bill",
  purchase_return: "Purchase Return",
  opening: "Opening Balance",
  adjustment: "Adjustment",
};

/** Full running-balance statement for a party, optional date window. */
export async function partyStatement(
  partyType: PartyType,
  partyId: number,
  opts?: { from?: string; to?: string }
): Promise<{
  opening_balance: number;
  closing_balance: number;
  rows: StatementRow[];
  totals: { debit: number; credit: number };
  from: string;
  to: string;
}> {
  const from = (opts?.from || "").slice(0, 10);
  const to = (opts?.to || "").slice(0, 10);
  const all = await query<any>(
    `SELECT entry_date AS d, source_type, source_id, ref, particulars, debit, credit
       FROM ledger_entries
      WHERE party_type = ? AND party_id = ?
      ORDER BY entry_date, id`,
    [partyType, partyId]
  );

  // 1. flat rows with running balance
  let opening = 0;
  let running = 0;
  const flat: (StatementRow & { _invRef?: string })[] = [];
  // which refs correspond to an actual sales invoice (so payment/return entries
  // sharing that ref can be nested under it)
  const invoiceRefs = new Set(
    all.filter((e) => e.source_type === "invoice").map((e) => String(e.ref || ""))
  );
  for (const e of all) {
    const date = String(e.d).slice(0, 10);
    running = round2(running + Number(e.debit) - Number(e.credit));
    if (from && date < from) {
      opening = running;
      continue;
    }
    if (to && date > to) continue;
    flat.push({
      date,
      source_type: e.source_type,
      source_id: e.source_id ?? null,
      ref: e.ref || "",
      particulars: KIND_LABEL[e.source_type] || e.source_type,
      kind_label: KIND_LABEL[e.source_type] || e.source_type,
      debit: round2(Number(e.debit)),
      credit: round2(Number(e.credit)),
      balance: running,
      _invRef:
        e.source_type !== "invoice" && invoiceRefs.has(String(e.ref || ""))
          ? String(e.ref)
          : undefined,
    });
  }

  // 2. group sub-lines under their invoice row
  const rows: StatementRow[] = [];
  const invIndex = new Map<string, StatementRow>();
  for (const r of flat) {
    if (r.source_type === "invoice") {
      const row: StatementRow = { ...r, children: [] };
      delete (row as any)._invRef;
      rows.push(row);
      invIndex.set(r.ref, row);
    } else if (r._invRef && invIndex.has(r._invRef)) {
      const parent = invIndex.get(r._invRef)!;
      const { _invRef, balance, children, ...child } = r as any;
      void _invRef;
      void balance;
      void children;
      parent.children!.push(child);
      // parent's running balance advances to include the child
      parent.balance = r.balance;
      parent.debit = round2(parent.debit + r.debit);
      parent.credit = round2(parent.credit + r.credit);
    } else {
      const row: StatementRow = { ...r };
      delete (row as any)._invRef;
      rows.push(row);
    }
  }
  for (const row of rows) if (row.children && row.children.length === 0) delete row.children;

  return {
    opening_balance: opening,
    closing_balance: running,
    rows,
    totals: {
      debit: round2(rows.reduce((s, r) => s + r.debit, 0)),
      credit: round2(rows.reduce((s, r) => s + r.credit, 0)),
    },
    from,
    to,
  };
}
