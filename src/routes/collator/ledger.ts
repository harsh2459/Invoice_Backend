/**
 * Collator ledger routes — Tally-style accounting on classified bank txns.
 * Port of Drogon `routes/ledger.py`. Mounted at /api/collator/ledger.
 *
 * Groups -> Ledgers -> keyword Rules. Bank transactions get a ledger_head_id
 * (auto via rules on import, or manual). Statements roll ledger balances up by
 * group. Single-entry approximation — Dr/Cr totals may not exactly balance.
 */
import { Router } from "express";
import { query, exec } from "../../db";
import {
  applyLedgerRules,
  applyPlatformTags,
  signedBalance,
  ledgerBalances,
  loadLedgersAndGroups,
  groupRollup,
  round2,
  type PeriodOpts,
  type Nature,
} from "../../collator/ledgerEngine";

const router = Router();

function period(q: any): PeriodOpts {
  return {
    companyId: q.company_id ? Number(q.company_id) : null,
    year: q.year ? Number(q.year) : null,
    month: q.month ? Number(q.month) : null,
    dateFrom: q.date_from || null,
    dateTo: q.date_to || null,
  };
}

// ---- Groups CRUD ----

router.get("/groups", async (_req, res, next) => {
  try {
    res.json(await query("SELECT * FROM col_ledger_groups ORDER BY name"));
  } catch (e) {
    next(e);
  }
});
router.post("/groups", async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    const nature = req.body.nature || "expense";
    if (!name) return res.status(400).json({ error: "Name required" });
    const dup = await query("SELECT id FROM col_ledger_groups WHERE name = ?", [name]);
    if (dup.length) return res.status(400).json({ error: "Group already exists" });
    const r = await exec(
      "INSERT INTO col_ledger_groups (name, nature) VALUES (?, ?)",
      [name, nature]
    );
    res.json({ id: r.insertId, name, nature });
  } catch (e) {
    next(e);
  }
});
router.put("/groups/:id", async (req, res, next) => {
  try {
    const r = await exec(
      "UPDATE col_ledger_groups SET name = ?, nature = ?, active = ? WHERE id = ?",
      [
        (req.body.name || "").trim(),
        req.body.nature || "expense",
        req.body.active === false ? 0 : 1,
        req.params.id,
      ]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Group not found" });
    res.json({ id: Number(req.params.id) });
  } catch (e) {
    next(e);
  }
});
router.delete("/groups/:id", async (req, res, next) => {
  try {
    const used = await query("SELECT id FROM col_ledgers WHERE group_id = ? LIMIT 1", [
      req.params.id,
    ]);
    if (used.length)
      return res.status(400).json({ error: "Move or delete ledgers under this group first" });
    await exec("DELETE FROM col_ledger_groups WHERE id = ?", [req.params.id]);
    res.json({ status: "deleted" });
  } catch (e) {
    next(e);
  }
});

// ---- Ledgers CRUD ----

router.get("/ledgers", async (_req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT l.id, l.name, l.group_id, l.color, l.active,
              g.name group_name, g.nature
       FROM col_ledgers l LEFT JOIN col_ledger_groups g ON g.id = l.group_id
       ORDER BY l.name`
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});
router.post("/ledgers", async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    const groupId = Number(req.body.group_id);
    if (!name || !groupId) return res.status(400).json({ error: "Name and group required" });
    const dup = await query("SELECT id FROM col_ledgers WHERE name = ?", [name]);
    if (dup.length) return res.status(400).json({ error: "Ledger already exists" });
    const g = await query("SELECT id FROM col_ledger_groups WHERE id = ?", [groupId]);
    if (!g.length) return res.status(404).json({ error: "Group not found" });
    const r = await exec(
      "INSERT INTO col_ledgers (name, group_id, color) VALUES (?, ?, ?)",
      [name, groupId, req.body.color || "#1a6fd4"]
    );
    res.json({ id: r.insertId, name, group_id: groupId });
  } catch (e) {
    next(e);
  }
});
router.put("/ledgers/:id", async (req, res, next) => {
  try {
    const r = await exec(
      "UPDATE col_ledgers SET name = ?, group_id = ?, color = ?, active = ? WHERE id = ?",
      [
        (req.body.name || "").trim(),
        Number(req.body.group_id),
        req.body.color || "#1a6fd4",
        req.body.active === false ? 0 : 1,
        req.params.id,
      ]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Ledger not found" });
    res.json({ id: Number(req.params.id) });
  } catch (e) {
    next(e);
  }
});
router.delete("/ledgers/:id", async (req, res, next) => {
  try {
    await exec("DELETE FROM col_ledger_rules WHERE ledger_id = ?", [req.params.id]);
    await exec(
      "UPDATE col_bank_txns SET ledger_head_id = NULL, ledger_manual = 0 WHERE ledger_head_id = ?",
      [req.params.id]
    );
    await exec("DELETE FROM col_ledgers WHERE id = ?", [req.params.id]);
    res.json({ status: "deleted" });
  } catch (e) {
    next(e);
  }
});

// ---- Rules ----

router.get("/rules", async (_req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT r.id, r.ledger_id, r.keyword, r.active, l.name ledger_name
       FROM col_ledger_rules r LEFT JOIN col_ledgers l ON l.id = r.ledger_id
       ORDER BY l.name, r.keyword`
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});
router.post("/rules", async (req, res, next) => {
  try {
    const ledgerId = Number(req.body.ledger_id);
    const kws = String(req.body.keywords || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (!ledgerId) return res.status(404).json({ error: "Ledger required" });
    if (!kws.length) return res.status(400).json({ error: "At least one keyword required" });
    for (const kw of kws)
      await exec("INSERT INTO col_ledger_rules (ledger_id, keyword) VALUES (?, ?)", [ledgerId, kw]);
    const autoAssigned = await applyLedgerRules();
    res.json({ ledger_id: ledgerId, keywords_created: kws, auto_assigned: autoAssigned });
  } catch (e) {
    next(e);
  }
});
router.delete("/rules/:id", async (req, res, next) => {
  try {
    await exec("DELETE FROM col_ledger_rules WHERE id = ?", [req.params.id]);
    res.json({ status: "deleted" });
  } catch (e) {
    next(e);
  }
});
router.post("/apply-rules", async (_req, res, next) => {
  try {
    res.json({ transactions_updated: await applyLedgerRules() });
  } catch (e) {
    next(e);
  }
});

// ---- Assign transactions ----

router.put("/transactions/:id/assign", async (req, res, next) => {
  try {
    const ledgerId = req.body.ledger_id == null ? null : Number(req.body.ledger_id);
    const r = await exec(
      "UPDATE col_bank_txns SET ledger_head_id = ?, ledger_manual = ? WHERE id = ?",
      [ledgerId, ledgerId == null ? 0 : 1, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Transaction not found" });
    res.json({ id: Number(req.params.id), ledger_id: ledgerId });
  } catch (e) {
    next(e);
  }
});

router.post("/transactions/bulk-assign", async (req, res, next) => {
  try {
    const ledgerId = req.body.ledger_id == null ? null : Number(req.body.ledger_id);
    const ids: number[] = Array.isArray(req.body.transaction_ids)
      ? req.body.transaction_ids.map(Number)
      : [];
    let where: string;
    let params: any[];
    if (ids.length) {
      where = `id IN (${ids.map(() => "?").join(",")})`;
      params = ids;
    } else {
      const w: string[] = ["1=1"];
      const p: any[] = [];
      if (req.body.company_id) {
        w.push("company_id = ?");
        p.push(Number(req.body.company_id));
      }
      if (req.body.search) {
        w.push("(description LIKE ? OR ref_number LIKE ?)");
        p.push(`%${req.body.search}%`, `%${req.body.search}%`);
      }
      if (req.body.bank_name) {
        w.push("bank_name = ?");
        p.push(req.body.bank_name);
      }
      if (req.body.txn_kind === "debit") w.push("debit > 0");
      else if (req.body.txn_kind === "credit") w.push("credit > 0");
      if (req.body.date_from) {
        w.push("transaction_date >= ?");
        p.push(req.body.date_from);
      }
      if (req.body.date_to) {
        w.push("transaction_date <= ?");
        p.push(req.body.date_to);
      }
      if (req.body.uncategorized_filter) w.push("ledger_head_id IS NULL");
      else if (req.body.ledger_filter) {
        w.push("ledger_head_id = ?");
        p.push(Number(req.body.ledger_filter));
      } else if (req.body.group_filter) {
        w.push(
          "ledger_head_id IN (SELECT id FROM col_ledgers WHERE group_id = ?)"
        );
        p.push(Number(req.body.group_filter));
      }
      where = w.join(" AND ");
      params = p;
    }
    const r = await exec(
      `UPDATE col_bank_txns SET ledger_head_id = ?, ledger_manual = ? WHERE ${where}`,
      [ledgerId, ledgerId == null ? 0 : 1, ...params]
    );
    res.json({ transactions_updated: r.affectedRows });
  } catch (e) {
    next(e);
  }
});

// ---- Summary (per ledger, grouped) ----

router.get("/summary", async (req, res, next) => {
  try {
    const o = period(req.query);
    const w: string[] = ["1=1"];
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
    const activity = await query<any>(
      `SELECT ledger_head_id, COALESCE(SUM(credit),0) credit, COALESCE(SUM(debit),0) debit, COUNT(*) n
       FROM col_bank_txns WHERE ${w.join(" AND ")} GROUP BY ledger_head_id`,
      p
    );
    const byLedger = new Map<number | null, any>(
      activity.map((a) => [a.ledger_head_id == null ? null : Number(a.ledger_head_id), a])
    );
    const { ledgers, groups } = await loadLedgersAndGroups();

    const natureFilter = req.query.nature as string | undefined;
    const result: any[] = [];
    for (const l of ledgers) {
      const g = groups.get(l.group_id);
      if (natureFilter && g?.nature !== natureFilter) continue;
      const a = byLedger.get(l.id);
      result.push({
        ledger_id: l.id,
        ledger_name: l.name,
        group_id: l.group_id,
        group_name: g?.name ?? null,
        nature: g?.nature ?? null,
        color: l.color,
        credit: a ? Number(a.credit) : 0,
        debit: a ? Number(a.debit) : 0,
        count: a ? Number(a.n) : 0,
      });
    }
    const unc = byLedger.get(null);
    if (unc && !natureFilter)
      result.push({
        ledger_id: null,
        ledger_name: "Uncategorized",
        group_id: null,
        group_name: null,
        nature: null,
        color: "#999999",
        credit: Number(unc.credit),
        debit: Number(unc.debit),
        count: Number(unc.n),
      });
    result.sort((a, b) => b.debit + b.credit - (a.debit + a.credit));

    const totals_by_nature: Record<string, number> = {
      income: 0,
      expense: 0,
      asset: 0,
      liability: 0,
    };
    for (const r of result)
      if (r.nature in totals_by_nature) totals_by_nature[r.nature] += r.credit + r.debit;

    res.json({ ledgers: result, totals_by_nature });
  } catch (e) {
    next(e);
  }
});

// ---- Balance Sheet ----

router.get("/balance-sheet", async (req, res, next) => {
  try {
    const o = period(req.query);
    const assets = await groupRollup(["asset"], o);
    const liabilities = await groupRollup(["liability"], o);
    const total_assets = round2(assets.reduce((s, g) => s + g.total, 0));
    const total_liabilities = round2(liabilities.reduce((s, g) => s + g.total, 0));
    res.json({
      assets,
      liabilities,
      total_assets,
      total_liabilities,
      difference: round2(total_assets - total_liabilities),
      note:
        "Single-entry approximation from categorized bank transactions — Assets may not equal Liabilities.",
    });
  } catch (e) {
    next(e);
  }
});

// ---- Trial Balance ----

router.get("/trial-balance", async (req, res, next) => {
  try {
    const o = period(req.query);
    const includeZero = req.query.include_zero === "true" || req.query.include_zero === "1";
    const bals = await ledgerBalances(o);
    const { ledgers, groups } = await loadLedgersAndGroups();

    const rows: any[] = [];
    let total_debit = 0;
    let total_credit = 0;
    for (const l of ledgers) {
      const g = groups.get(l.group_id);
      const nature = g?.nature ?? "expense";
      const b = bals.get(l.id) || { credit: 0, debit: 0, count: 0 };
      const signed = signedBalance(nature, b.debit, b.credit);
      if (signed === 0 && b.count === 0 && !includeZero) continue;
      let debit_col: number, credit_col: number;
      if (nature === "asset" || nature === "expense") {
        debit_col = round2(Math.max(signed, 0));
        credit_col = round2(Math.max(-signed, 0));
      } else {
        credit_col = round2(Math.max(signed, 0));
        debit_col = round2(Math.max(-signed, 0));
      }
      total_debit += debit_col;
      total_credit += credit_col;
      rows.push({
        ledger_id: l.id,
        ledger_name: l.name,
        group_id: l.group_id,
        group_name: g?.name ?? null,
        nature,
        debit: debit_col,
        credit: credit_col,
        count: b.count,
      });
    }
    rows.sort(
      (a, b) =>
        (a.group_name || "").localeCompare(b.group_name || "") ||
        a.ledger_name.localeCompare(b.ledger_name)
    );
    res.json({
      rows,
      total_debit: round2(total_debit),
      total_credit: round2(total_credit),
      difference: round2(total_debit - total_credit),
      note: "Single-entry — a large Dr/Cr gap usually means transactions are miscategorized.",
    });
  } catch (e) {
    next(e);
  }
});

// ---- P&L A/c ----

const DIRECT_INCOME = new Set(["Sales Accounts", "Direct Incomes", "Income (Direct)"]);
const DIRECT_EXPENSE = new Set(["Purchase Accounts", "Direct Expenses", "Expenses (Direct)"]);
const INDIRECT_INCOME = new Set(["Indirect Incomes", "Income (Indirect)"]);
const INDIRECT_EXPENSE = new Set(["Indirect Expenses", "Expenses (Indirect)"]);

router.get("/pnl", async (req, res, next) => {
  try {
    const o = period(req.query);
    const income_groups = await groupRollup(["income"], o);
    const expense_groups = await groupRollup(["expense"], o);
    const totFor = (groups: any[], names: Set<string>) =>
      round2(groups.filter((g) => names.has(g.group_name)).reduce((s, g) => s + g.total, 0));
    const direct_income = totFor(income_groups, DIRECT_INCOME);
    const direct_expense = totFor(expense_groups, DIRECT_EXPENSE);
    const indirect_income = totFor(income_groups, INDIRECT_INCOME);
    const indirect_expense = totFor(expense_groups, INDIRECT_EXPENSE);
    const gross_profit = round2(direct_income - direct_expense);
    const net_profit = round2(gross_profit + indirect_income - indirect_expense);
    res.json({
      income_groups,
      expense_groups,
      direct_income,
      direct_expense,
      indirect_income,
      indirect_expense,
      gross_profit,
      net_profit,
    });
  } catch (e) {
    next(e);
  }
});

// ---- Group drill-down ----

router.get("/groups/:id/drill-down", async (req, res, next) => {
  try {
    const o = period(req.query);
    const gRows = await query<any>("SELECT * FROM col_ledger_groups WHERE id = ?", [req.params.id]);
    if (!gRows[0]) return res.status(404).json({ error: "Group not found" });
    const g = gRows[0];
    const bals = await ledgerBalances(o);
    const ledgers = await query<any>(
      "SELECT id, name, color FROM col_ledgers WHERE group_id = ?",
      [req.params.id]
    );
    const out = ledgers
      .map((l) => {
        const b = bals.get(l.id) || { credit: 0, debit: 0, count: 0 };
        return {
          ledger_id: l.id,
          ledger_name: l.name,
          color: l.color,
          credit: round2(b.credit),
          debit: round2(b.debit),
          balance: round2(signedBalance(g.nature, b.debit, b.credit)),
          count: b.count,
        };
      })
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    res.json({ group_id: g.id, group_name: g.name, nature: g.nature, ledgers: out });
  } catch (e) {
    next(e);
  }
});

// ---- Ledger monthly breakdown ----

router.get("/ledgers/:id/monthly", async (req, res, next) => {
  try {
    const lRows = await query<any>(
      `SELECT l.id, l.name, g.name group_name, g.nature
       FROM col_ledgers l LEFT JOIN col_ledger_groups g ON g.id = l.group_id WHERE l.id = ?`,
      [req.params.id]
    );
    if (!lRows[0]) return res.status(404).json({ error: "Ledger not found" });
    const l = lRows[0];
    const p: any[] = [req.params.id];
    let cw = "";
    if (req.query.company_id) {
      cw = " AND company_id = ?";
      p.push(Number(req.query.company_id));
    }
    const rows = await query<any>(
      `SELECT data_year yr, data_month mo,
              COALESCE(SUM(credit),0) credit, COALESCE(SUM(debit),0) debit
       FROM col_bank_txns WHERE ledger_head_id = ?${cw}
       GROUP BY data_year, data_month ORDER BY data_year, data_month`,
      p
    );
    let running = 0;
    const months = rows.map((r) => {
      const change = signedBalance(l.nature, Number(r.debit), Number(r.credit));
      running += change;
      return {
        year: Number(r.yr),
        month: Number(r.mo),
        debit: round2(r.debit),
        credit: round2(r.credit),
        change: round2(change),
        closing_balance: round2(running),
      };
    });
    res.json({
      ledger_id: l.id,
      ledger_name: l.name,
      group_name: l.group_name,
      nature: l.nature,
      months,
      closing_balance: round2(running),
    });
  } catch (e) {
    next(e);
  }
});

// ---- Day Book (bank txns + fee invoices merged) ----

router.get("/day-book", async (req, res, next) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const ledgerId = req.query.ledger_id ? Number(req.query.ledger_id) : null;

    const bw: string[] = ["1=1"];
    const bp: any[] = [];
    if (req.query.company_id) {
      bw.push("b.company_id = ?");
      bp.push(Number(req.query.company_id));
    }
    if (req.query.date_from) {
      bw.push("b.transaction_date >= ?");
      bp.push(req.query.date_from);
    }
    if (req.query.date_to) {
      bw.push("b.transaction_date <= ?");
      bp.push(req.query.date_to);
    }
    if (ledgerId) {
      bw.push("b.ledger_head_id = ?");
      bp.push(ledgerId);
    }
    const bankRows = await query<any>(
      `SELECT b.id, b.transaction_date, b.description, b.ref_number, b.debit, b.credit,
              b.ledger_head_id, l.name ledger_name, l.color ledger_color
       FROM col_bank_txns b LEFT JOIN col_ledgers l ON l.id = b.ledger_head_id
       WHERE ${bw.join(" AND ")}`,
      bp
    );

    let feeRows: any[] = [];
    if (!ledgerId) {
      const fw: string[] = ["1=1"];
      const fp: any[] = [];
      if (req.query.company_id) {
        fw.push("company_id = ?");
        fp.push(Number(req.query.company_id));
      }
      if (req.query.date_from) {
        fw.push("invoice_date >= ?");
        fp.push(req.query.date_from);
      }
      if (req.query.date_to) {
        fw.push("invoice_date <= ?");
        fp.push(req.query.date_to);
      }
      feeRows = await query<any>(
        `SELECT id, invoice_date, vendor, description, total_amount, invoice_number
         FROM col_fee_invoices WHERE ${fw.join(" AND ")}`,
        fp
      );
    }

    const feed = [
      ...bankRows.map((b) => ({
        type: "bank" as const,
        id: b.id,
        date: String(b.transaction_date),
        particulars: b.description || "",
        ref_number: b.ref_number,
        ledger_id: b.ledger_head_id,
        ledger_name: b.ledger_name || "Uncategorized",
        ledger_color: b.ledger_color || "#999999",
        debit: round2(b.debit),
        credit: round2(b.credit),
      })),
      ...feeRows.map((f) => ({
        type: "fee" as const,
        id: f.id,
        date: String(f.invoice_date),
        particulars: f.vendor || f.description || "",
        ref_number: f.invoice_number,
        ledger_id: null,
        ledger_name: "Purchase Accounts",
        ledger_color: "#e67e00",
        debit: round2(f.total_amount),
        credit: 0,
      })),
    ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const total = feed.length;
    const rows = feed.slice(skip, skip + limit);
    res.json({
      total,
      rows,
      totals: {
        debit: round2(feed.reduce((s, r) => s + r.debit, 0)),
        credit: round2(feed.reduce((s, r) => s + r.credit, 0)),
      },
    });
  } catch (e) {
    next(e);
  }
});

// ---- Bank Book (one account, running balance + reconciliation) ----

router.get("/bank-book", async (req, res, next) => {
  try {
    const bankName = String(req.query.bank_name || "");
    if (!bankName) return res.status(400).json({ error: "bank_name is required" });
    const w: string[] = ["bank_name = ?"];
    const p: any[] = [bankName];
    if (req.query.account_number) {
      w.push("account_number = ?");
      p.push(req.query.account_number);
    }
    if (req.query.company_id) {
      w.push("company_id = ?");
      p.push(Number(req.query.company_id));
    }
    // full history, ordered oldest first (importer assigns ids reverse of statement order)
    const all = await query<any>(
      `SELECT b.id, b.transaction_date, b.description, b.ref_number, b.debit, b.credit, b.balance,
              b.ledger_head_id, l.name ledger_name, l.color ledger_color
       FROM col_bank_txns b LEFT JOIN col_ledgers l ON l.id = b.ledger_head_id
       WHERE ${w.join(" AND ")}
       ORDER BY b.transaction_date ASC, b.id DESC`,
      p
    );
    const includeRecon =
      req.query.include_reconciliation === "true" || req.query.include_reconciliation === "1";
    const tol = Number(req.query.tolerance) || 1;

    let running = 0;
    if (includeRecon && all[0]?.balance != null) {
      running = Number(all[0].balance) - (Number(all[0].credit) - Number(all[0].debit));
    }
    let mismatch_count = 0;
    let first_mismatch_date: string | null = null;

    const withRunning = all.map((t) => {
      running += Number(t.credit) - Number(t.debit);
      const row: any = {
        id: t.id,
        date: String(t.transaction_date),
        particulars: t.description || "",
        ref_number: t.ref_number,
        ledger_id: t.ledger_head_id,
        ledger_name: t.ledger_name || "Uncategorized",
        ledger_color: t.ledger_color || "#999999",
        debit: round2(t.debit),
        credit: round2(t.credit),
        running_balance: round2(running),
      };
      if (includeRecon) {
        const stmt = t.balance == null ? null : Number(t.balance);
        row.statement_balance = stmt;
        row.diff = stmt == null ? null : round2(running - stmt);
        row.mismatched = stmt != null && Math.abs(running - stmt) > tol;
        if (row.mismatched) {
          mismatch_count++;
          if (!first_mismatch_date) first_mismatch_date = row.date;
        }
      }
      return row;
    });

    let rows = withRunning;
    if (req.query.date_from) rows = rows.filter((r) => r.date >= req.query.date_from!);
    if (req.query.date_to) rows = rows.filter((r) => r.date <= req.query.date_to!);
    if (req.query.only_mismatches === "true") rows = rows.filter((r) => r.mismatched);

    res.json({
      bank_name: bankName,
      account_number: req.query.account_number || (all[0]?.account_number ?? null),
      rows,
      total_debit: round2(rows.reduce((s, r) => s + r.debit, 0)),
      total_credit: round2(rows.reduce((s, r) => s + r.credit, 0)),
      closing_balance: round2(running),
      mismatch_count,
      first_mismatch_date,
    });
  } catch (e) {
    next(e);
  }
});

// ---- Ratios ----

const safeRatio = (num: number, den: number, pct = false): number | null => {
  if (!den) return null;
  return round2((num / den) * (pct ? 100 : 1));
};

router.get("/ratios", async (req, res, next) => {
  try {
    const o = period(req.query);
    const income_groups = await groupRollup(["income"], o);
    const expense_groups = await groupRollup(["expense"], o);
    const assets = await groupRollup(["asset"], o);
    const liabilities = await groupRollup(["liability"], o);
    const totFor = (groups: any[], names: Set<string>) =>
      groups.filter((g) => names.has(g.group_name)).reduce((s, g) => s + g.total, 0);
    const direct_income = totFor(income_groups, DIRECT_INCOME);
    const direct_expense = totFor(expense_groups, DIRECT_EXPENSE);
    const indirect_income = totFor(income_groups, INDIRECT_INCOME);
    const indirect_expense = totFor(expense_groups, INDIRECT_EXPENSE);
    const gross_profit = direct_income - direct_expense;
    const net_profit = gross_profit + indirect_income - indirect_expense;
    const total_income = direct_income + indirect_income;
    const total_expense = direct_expense + indirect_expense;
    const total_assets = assets.reduce((s, g) => s + g.total, 0);
    const total_liabilities = liabilities.reduce((s, g) => s + g.total, 0);
    res.json({
      ratios: {
        gross_profit_margin: safeRatio(gross_profit, direct_income, true),
        net_profit_margin: safeRatio(net_profit, total_income, true),
        expense_to_income: safeRatio(total_expense, total_income, true),
        current_ratio: safeRatio(total_assets, total_liabilities),
        return_on_assets: safeRatio(net_profit, total_assets, true),
        working_capital: round2(total_assets - total_liabilities),
      },
      note: "Derived from categorized bank transactions only (single-entry).",
    });
  } catch (e) {
    next(e);
  }
});

// ---- Compare two periods ----

async function ledgerNetBalances(companyId: number | null, year: number, month: number) {
  const bals = await ledgerBalances({ companyId, year, month });
  const { ledgers, groups } = await loadLedgersAndGroups();
  const m = new Map<number, { name: string; group: string; nature: string; net: number }>();
  for (const l of ledgers) {
    const g = groups.get(l.group_id);
    const b = bals.get(l.id) || { credit: 0, debit: 0, count: 0 };
    m.set(l.id, {
      name: l.name,
      group: g?.name ?? "",
      nature: g?.nature ?? "",
      net: round2(signedBalance(g?.nature ?? "expense", b.debit, b.credit)),
    });
  }
  return m;
}

router.get("/compare", async (req, res, next) => {
  try {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const ya = Number(req.query.year_a);
    const yb = Number(req.query.year_b);
    if (!ya || !yb) return res.status(400).json({ error: "year_a and year_b are required" });
    const ma = Number(req.query.month_a) || 0;
    const mb = Number(req.query.month_b) || 0;
    const A = await ledgerNetBalances(companyId, ya, ma);
    const B = await ledgerNetBalances(companyId, yb, mb);
    const ids = new Set([...A.keys(), ...B.keys()]);
    const rows: any[] = [];
    let total_a = 0;
    let total_b = 0;
    for (const id of ids) {
      const a = A.get(id);
      const b = B.get(id);
      const pa = a?.net ?? 0;
      const pb = b?.net ?? 0;
      if (pa === 0 && pb === 0) continue;
      total_a += pa;
      total_b += pb;
      rows.push({
        ledger_id: id,
        ledger_name: a?.name ?? b?.name,
        group_name: a?.group ?? b?.group,
        nature: a?.nature ?? b?.nature,
        period_a: pa,
        period_b: pb,
        change: round2(pb - pa),
        change_pct: pa ? round2(((pb - pa) / Math.abs(pa)) * 100) : null,
      });
    }
    rows.sort(
      (x, y) =>
        (x.group_name || "").localeCompare(y.group_name || "") ||
        x.ledger_name.localeCompare(y.ledger_name)
    );
    res.json({
      period_a_label: ma ? `${ma}/${ya}` : `${ya}`,
      period_b_label: mb ? `${mb}/${yb}` : `${yb}`,
      rows,
      total_a: round2(total_a),
      total_b: round2(total_b),
    });
  } catch (e) {
    next(e);
  }
});

// ---- Exception reports ----

router.get("/exceptions", async (req, res, next) => {
  try {
    const dormantDays = Number(req.query.dormant_days) || 60;
    const outlierMult = Number(req.query.outlier_multiple) || 4;
    const scopeW: string[] = ["1=1"];
    const scopeP: any[] = [];
    if (req.query.company_id) {
      scopeW.push("company_id = ?");
      scopeP.push(Number(req.query.company_id));
    }
    if (req.query.date_from) {
      scopeW.push("transaction_date >= ?");
      scopeP.push(req.query.date_from);
    }
    if (req.query.date_to) {
      scopeW.push("transaction_date <= ?");
      scopeP.push(req.query.date_to);
    }
    const scoped = scopeW.join(" AND ");

    // 1. large uncategorized
    const large_uncategorized = (
      await query<any>(
        `SELECT id, transaction_date, description, GREATEST(debit, credit) amt
         FROM col_bank_txns
         WHERE ${scoped} AND ledger_head_id IS NULL AND (debit > 0 OR credit > 0)
         ORDER BY amt DESC LIMIT 20`,
        scopeP
      )
    ).map((r) => ({
      id: r.id,
      date: String(r.transaction_date),
      particulars: r.description || "",
      amount: round2(r.amt),
    }));

    // 2. dormant ledgers (full history)
    const lastAct = await query<any>(
      `SELECT ledger_head_id, MAX(transaction_date) last_date
       FROM col_bank_txns WHERE ledger_head_id IS NOT NULL GROUP BY ledger_head_id`
    );
    const lastMap = new Map(lastAct.map((r) => [Number(r.ledger_head_id), String(r.last_date)]));
    const { ledgers } = await loadLedgersAndGroups();
    const cutoff = new Date(Date.now() - dormantDays * 86400000).toISOString().slice(0, 10);
    const dormant_ledgers = ledgers
      .map((l) => {
        const last = lastMap.get(l.id);
        if (!last || last >= cutoff) return null;
        return {
          ledger_id: l.id,
          ledger_name: l.name,
          last_activity: last,
          days_since: Math.floor((Date.now() - new Date(last).getTime()) / 86400000),
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.days_since - a.days_since);

    // 3. outliers vs per-ledger average (full history baseline, min 5 txns)
    const avgRows = await query<any>(
      `SELECT ledger_head_id, AVG(GREATEST(debit, credit)) avg_amt, COUNT(*) n
       FROM col_bank_txns WHERE ledger_head_id IS NOT NULL GROUP BY ledger_head_id`
    );
    const avgMap = new Map<number, number>();
    for (const r of avgRows)
      if (Number(r.n) >= 5 && Number(r.avg_amt) > 0)
        avgMap.set(Number(r.ledger_head_id), Number(r.avg_amt));
    const outlierCandidates = await query<any>(
      `SELECT b.id, b.transaction_date, b.description, b.ledger_head_id,
              GREATEST(b.debit, b.credit) amt, l.name ledger_name
       FROM col_bank_txns b LEFT JOIN col_ledgers l ON l.id = b.ledger_head_id
       WHERE ${scoped} AND b.ledger_head_id IS NOT NULL`,
      scopeP
    );
    const outliers = outlierCandidates
      .map((r) => {
        const avg = avgMap.get(Number(r.ledger_head_id));
        if (!avg || Number(r.amt) < avg * outlierMult) return null;
        return {
          id: r.id,
          date: String(r.transaction_date),
          ledger_id: r.ledger_head_id,
          ledger_name: r.ledger_name,
          amount: round2(r.amt),
          ledger_average: round2(avg),
          particulars: r.description || "",
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.amount / b.ledger_average - a.amount / a.ledger_average)
      .slice(0, 20);

    // 4. possible duplicates (same date + amount + direction)
    const dupRows = await query<any>(
      `SELECT transaction_date, ROUND(GREATEST(debit, credit), 2) amt, (debit > 0) is_debit,
              COUNT(*) n, GROUP_CONCAT(id) ids, GROUP_CONCAT(description SEPARATOR ' || ') descs
       FROM col_bank_txns WHERE ${scoped} AND (debit > 0 OR credit > 0)
       GROUP BY transaction_date, amt, is_debit HAVING n > 1
       ORDER BY amt DESC LIMIT 20`,
      scopeP
    );
    const possible_duplicates = dupRows.map((r) => ({
      date: String(r.transaction_date),
      amount: round2(r.amt),
      kind: r.is_debit ? "debit" : "credit",
      count: Number(r.n),
      transaction_ids: String(r.ids).split(",").map(Number),
      particulars: String(r.descs).split(" || "),
    }));

    res.json({
      large_uncategorized,
      dormant_ledgers,
      outliers,
      possible_duplicates,
      counts: {
        large_uncategorized: large_uncategorized.length,
        dormant_ledgers: dormant_ledgers.length,
        outliers: outliers.length,
        possible_duplicates: possible_duplicates.length,
      },
    });
  } catch (e) {
    next(e);
  }
});

// ---- Platform tags / cost centres ----

router.post("/platforms/apply", async (_req, res, next) => {
  try {
    res.json({ transactions_updated: await applyPlatformTags() });
  } catch (e) {
    next(e);
  }
});

router.put("/transactions/:id/platform", async (req, res, next) => {
  try {
    const platform = req.body.platform ?? null;
    if (platform && !["Amazon", "Flipkart", "Meesho", "Other"].includes(platform))
      return res.status(400).json({ error: "Invalid platform" });
    const r = await exec(
      "UPDATE col_bank_txns SET platform = ?, platform_manual = ? WHERE id = ?",
      [platform, platform ? 1 : 0, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Transaction not found" });
    res.json({ id: Number(req.params.id), platform });
  } catch (e) {
    next(e);
  }
});

router.get("/platforms/cross-tab", async (req, res, next) => {
  try {
    const w: string[] = ["b.ledger_head_id IS NOT NULL"];
    const p: any[] = [];
    if (req.query.company_id) {
      w.push("b.company_id = ?");
      p.push(Number(req.query.company_id));
    }
    if (req.query.date_from) {
      w.push("b.transaction_date >= ?");
      p.push(req.query.date_from);
    }
    if (req.query.date_to) {
      w.push("b.transaction_date <= ?");
      p.push(req.query.date_to);
    }
    const rows = await query<any>(
      `SELECT b.ledger_head_id, b.platform, b.debit, b.credit,
              l.name ledger_name, l.group_id, g.name group_name, g.nature
       FROM col_bank_txns b
       LEFT JOIN col_ledgers l ON l.id = b.ledger_head_id
       LEFT JOIN col_ledger_groups g ON g.id = l.group_id
       WHERE ${w.join(" AND ")}`,
      p
    );
    const platforms = ["Amazon", "Flipkart", "Meesho", "Other", "Unassigned"];
    const byLedger = new Map<number, any>();
    const platform_totals: Record<string, number> = Object.fromEntries(platforms.map((p) => [p, 0]));
    for (const r of rows) {
      const signed = signedBalance(r.nature || "expense", Number(r.debit), Number(r.credit));
      const plat = r.platform && platforms.includes(r.platform) ? r.platform : "Unassigned";
      let e = byLedger.get(r.ledger_head_id);
      if (!e) {
        e = {
          ledger_id: r.ledger_head_id,
          ledger_name: r.ledger_name,
          group_name: r.group_name,
          by_platform: Object.fromEntries(platforms.map((p) => [p, 0])),
          total: 0,
        };
        byLedger.set(r.ledger_head_id, e);
      }
      e.by_platform[plat] += signed;
      e.total += signed;
      platform_totals[plat] += signed;
    }
    const out = [...byLedger.values()]
      .map((e) => {
        e.total = round2(e.total);
        for (const k of platforms) e.by_platform[k] = round2(e.by_platform[k]);
        return e;
      })
      .sort(
        (a, b) =>
          (a.group_name || "").localeCompare(b.group_name || "") ||
          (a.ledger_name || "").localeCompare(b.ledger_name || "")
      );
    res.json({
      rows: out,
      platforms,
      platform_totals: Object.fromEntries(
        Object.entries(platform_totals).map(([k, v]) => [k, round2(v)])
      ),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
