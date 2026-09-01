/**
 * Bank statement parser -> col_bank_txns rows.
 * Loose port of Drogon `parsers/bank_parser.py`, retuned against pdfjs-dist.
 *
 * PDF: pdfjs text with x-positions. We detect the column header row
 *   (Transaction Date | Value Date | Cheque No/Reference No | Description |
 *    Withdrawals | Deposits | Running Balance) and bucket every subsequent
 *   line's fragments by x into those columns. Description continuation lines
 *   (no leading date) append to the current row.
 * If the header can't be found we fall back to a date-anchored text walk with
 *   keyword-based debit/credit inference (YES-bank style).
 *
 * XML: Tally voucher export. VOUCHERTYPENAME Payment -> debit, Receipt -> credit,
 *   Contra -> keyword inference. Amount from the non-bank ledger entry.
 */

// pdfjs-dist is ESM-only; backend is CJS (tsx). Dynamic import, like feeInvoiceParser.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjsPromise: Promise<any> | null = null;
function pdfjs(): Promise<any> {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

type Row = Record<string, unknown>;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "31 May 2026" / "31/05/2026" / "31-05-26" / "31-May-2026" -> "YYYY-MM-DD" or null. */
function parseDate(s: string): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    if (mm) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    if (mm) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function amount(s: string | undefined | null): number | null {
  if (!s) return null;
  const cleaned = String(s).replace(/[^\d.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const DATE_RE = /^\d{1,2}[\s/\-.](?:[A-Za-z]{3}[a-z]*|\d{1,2})[\s/\-.]\d{2,4}/;

const CREDIT_KW = [
  "neft cr", "amazon seller", "flipkart", "razorpay", "cashfree", "paytm",
  "internal ac for intermedi", "meesho", "shopify", "imps/", "upi/", "refund",
  "interest credit", "int.pd", "reversal",
];
const DEBIT_KW = [
  "salary", "wfh", "shiprocket", "xerox", "zerox", "guide ignou", "debit interest",
  "gst", "tax", "emi", "charges", "google", "ads",
];

function inferDir(desc: string): "debit" | "credit" {
  const d = (desc || "").toLowerCase();
  if (CREDIT_KW.some((k) => d.includes(k))) return "credit";
  if (DEBIT_KW.some((k) => d.includes(k))) return "debit";
  return "credit";
}

interface Frag {
  x: number;
  s: string;
}

async function pdfLines(buf: Buffer): Promise<Frag[][]> {
  const { getDocument } = await pdfjs();
  const doc = await getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
  const all: Frag[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map<number, Frag[]>();
    for (const it of tc.items as any[]) {
      if (typeof it.str !== "string" || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      let b = byY.get(y);
      if (!b) byY.set(y, (b = []));
      b.push({ x: it.transform[4], s: it.str });
    }
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      all.push(byY.get(y)!.sort((a, b) => a.x - b.x));
    }
  }
  return all;
}

/** Column x-boundaries from a header line. */
interface Cols {
  valueDate: number;
  ref: number;
  desc: number;
  withdrawal: number;
  deposit: number;
  balance: number;
}

function findHeader(lines: Frag[][]): { idx: number; cols: Cols } | null {
  for (let i = 0; i < lines.length; i++) {
    const joined = lines[i].map((f) => f.s.toLowerCase()).join(" ");
    if (
      /description/.test(joined) &&
      /(withdrawal|debit)/.test(joined) &&
      /(deposit|credit)/.test(joined) &&
      /balance/.test(joined)
    ) {
      const at = (frag: RegExp): number | null => {
        const f = lines[i].find((p) => frag.test(p.s.toLowerCase()));
        return f ? f.x : null;
      };
      const cols: Cols = {
        valueDate: at(/value/) ?? 60,
        ref: at(/cheque|reference|ref/) ?? 120,
        desc: at(/description|narration|particular/) ?? 280,
        withdrawal: at(/withdrawal|debit/) ?? 500,
        deposit: at(/deposit|credit/) ?? 595,
        balance: at(/balance/) ?? 660,
      };
      return { idx: i, cols };
    }
  }
  return null;
}

async function parsePdf(
  buf: Buffer,
  bankName: string,
  accountNumber: string | null
): Promise<Row[]> {
  const lines = await pdfLines(buf);
  const hdr = findHeader(lines);

  const mk = (
    date: string | null,
    valueDate: string | null,
    ref: string,
    desc: string,
    debit: number | null,
    credit: number | null,
    balance: number | null
  ): Row => ({
    bank_name: bankName,
    account_number: accountNumber,
    transaction_date: date,
    value_date: valueDate,
    ref_number: ref.trim() || null,
    description: desc.replace(/\s+/g, " ").trim() || null,
    debit: debit || 0,
    credit: credit || 0,
    balance,
    transaction_type: (debit || 0) > 0 ? "debit" : "credit",
    ledger_manual: 0,
    platform_manual: 0,
  });

  const rows: Row[] = [];

  if (hdr) {
    const { cols } = hdr;
    const depMid = (cols.withdrawal + cols.deposit) / 2;
    const balMid = (cols.deposit + cols.balance) / 2;
    // A real money amount: 1+ digits, optional comma groups, mandatory 2-decimal.
    // Account/reference numbers never match (no decimal point).
    const MONEY = /^-?[\d,]*\d\.\d{2}$/;
    // Header labels are centred over their columns but data is left-aligned, so
    // the "Description" label sits well right of the actual description text.
    // Ref tokens live near cols.ref; description starts a bit right of that and
    // runs until the first money column. Continuation lines are pure description.
    const refMax = cols.ref + 60;
    const descMax = cols.withdrawal - 20;

    let cur: {
      date: string | null;
      valueDate: string | null;
      ref: string[];
      desc: string[];
      wd: string | null;
      dep: string | null;
      bal: string | null;
    } | null = null;

    const flush = () => {
      if (!cur || !cur.date) return;
      rows.push(
        mk(
          cur.date,
          cur.valueDate,
          cur.ref.join(" "),
          cur.desc.join(" "),
          amount(cur.wd),
          amount(cur.dep),
          amount(cur.bal)
        )
      );
      cur = null;
    };

    for (const line of lines.slice(hdr.idx + 1)) {
      const first = (line[0]?.s ?? "").trim();
      const startsWithDate = DATE_RE.test(first);

      if (/phonebanking|regd office|end of statement|opening balance|closing balance/i.test(first.toLowerCase())) {
        flush();
        break;
      }

      if (startsWithDate) {
        flush();
        cur = { date: parseDate(first), valueDate: null, ref: [], desc: [], wd: null, dep: null, bal: null };
      }
      if (!cur) continue;

      line.forEach((f, i) => {
        const txt = f.s.trim();
        if (!txt) return;
        // the txn-date fragment itself
        if (startsWithDate && i === 0) return;

        // money column?  (only real N,NNN.NN values — never ref/account numbers)
        if (MONEY.test(txt) && f.x >= descMax) {
          if (f.x < depMid) cur!.wd = txt;
          else if (f.x < balMid) cur!.dep = txt;
          else cur!.bal = txt;
          return;
        }
        if (f.x < cols.ref - 10) {
          if (DATE_RE.test(txt)) cur!.valueDate = parseDate(txt);
          return;
        }
        if (f.x <= refMax) {
          cur!.ref.push(txt);
          return;
        }
        // everything else left of the money columns is description
        if (f.x < descMax) cur!.desc.push(txt);
      });
    }
    flush();
  }

  if (rows.length === 0) {
    // text fallback: walk date-anchored blocks
    let block: string[] = [];
    let date: string | null = null;
    const emit = () => {
      if (!date || block.length === 0) return;
      const text = block.join(" ").replace(/\s+/g, " ").trim();
      // last two number-ish tokens: [amount, balance]
      const nums = text.match(/-?[\d,]+\.\d{2}/g) || [];
      const bal = nums.length ? amount(nums[nums.length - 1]) : null;
      const amt = nums.length >= 2 ? Math.abs(amount(nums[nums.length - 2]) || 0) : null;
      const dir = inferDir(text);
      rows.push(
        mk(
          date,
          null,
          "",
          text.replace(/-?[\d,]+\.\d{2}/g, "").trim(),
          dir === "debit" ? amt : null,
          dir === "credit" ? amt : null,
          bal
        )
      );
      block = [];
    };
    for (const line of lines) {
      const s = line.map((f) => f.s).join(" ").trim();
      if (DATE_RE.test(s)) {
        emit();
        date = parseDate(s);
        block = [s];
      } else if (date) {
        block.push(s);
      }
    }
    emit();
  }

  return rows.filter((r) => r.transaction_date && ((r.debit as number) > 0 || (r.credit as number) > 0));
}

// ---- XML (Tally voucher export) ----

async function parseXml(
  buf: Buffer,
  bankName: string,
  accountNumber: string | null
): Promise<Row[]> {
  const { XMLParser } = await import("fast-xml-parser");
  const parser = new XMLParser({ ignoreAttributes: true, trimValues: true, parseTagValue: true });
  let j: any;
  try {
    j = parser.parse(buf.toString("utf8"));
  } catch {
    return [];
  }
  let tm = j?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
  if (!tm) return [];
  if (!Array.isArray(tm)) tm = [tm];

  const vouchers = tm
    .filter((m: any) => m.VOUCHER)
    .flatMap((m: any) => (Array.isArray(m.VOUCHER) ? m.VOUCHER : [m.VOUCHER]));

  const rows: Row[] = [];
  for (const v of vouchers) {
    const type = String(v.VOUCHERTYPENAME || "");
    if (!/payment|receipt|contra/i.test(type)) continue;

    const dRaw = String(v.DATE || v.EFFECTIVEDATE || "");
    const date = dRaw.match(/^(\d{4})(\d{2})(\d{2})$/)
      ? `${dRaw.slice(0, 4)}-${dRaw.slice(4, 6)}-${dRaw.slice(6, 8)}`
      : parseDate(dRaw);
    if (!date) continue;

    const narration = String(v.NARRATION || "").replace(/\s+/g, " ").trim();

    // amount from the ledger entry that isn't the bank ledger
    let entries = v["ALLLEDGERENTRIES.LIST"] ?? v["LEDGERENTRIES.LIST"];
    if (entries && !Array.isArray(entries)) entries = [entries];
    let amt = 0;
    if (Array.isArray(entries)) {
      const other = entries.find(
        (e: any) => String(e.LEDGERNAME || "").toLowerCase() !== bankName.toLowerCase()
      );
      amt = Math.abs(Number((other || entries[0])?.AMOUNT || 0));
    }
    if (!amt) continue;

    let dir: "debit" | "credit";
    if (/payment/i.test(type)) dir = "debit";
    else if (/receipt/i.test(type)) dir = "credit";
    else dir = inferDir(narration);

    rows.push({
      bank_name: bankName,
      account_number: accountNumber,
      transaction_date: date,
      value_date: null,
      ref_number: null,
      description: narration || null,
      debit: dir === "debit" ? amt : 0,
      credit: dir === "credit" ? amt : 0,
      balance: null,
      transaction_type: dir,
      ledger_manual: 0,
      platform_manual: 0,
    });
  }
  return rows;
}

export async function parseBankFile(
  buf: Buffer,
  opts: { ext: string; bankName: string; accountNumber: string | null }
): Promise<Row[]> {
  if (opts.ext === "xml") return parseXml(buf, opts.bankName, opts.accountNumber);
  return parsePdf(buf, opts.bankName, opts.accountNumber);
}
