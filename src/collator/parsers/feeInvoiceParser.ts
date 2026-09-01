/**
 * Amazon fee / advertising invoice PDF -> col_fee_invoices rows.
 * Loose port of Drogon `parsers/purchase_parser.py`, retuned against real
 * pdfjs-dist text extraction (which x-sorts each line's fragments).
 *
 * Strategy: SUMMARY-FIRST. Drogon's "Details of Fees" daily-line-item regex is
 * too fragile against real layouts (wrapped descriptions, description before/
 * after the date). Instead we read the reliable page-1 service-summary table
 * ("SI No | Category | Description | Tax Rate | Amount") — one row per service
 * category with its own fee + IGST — and fall back to a single summary record
 * from the "Subtotal ..." lines if that table can't be read.
 *
 * invoice_type from the invoice-number prefix:
 *   ADS -> "Amazon Advertising"   KA / KAC -> "Amazon Services"   else -> "Amazon Purchase"
 */
// pdfjs-dist is ESM-only; the backend is CommonJS (run via tsx). Load it through
// a dynamic import() — same pattern as whatsapp.ts with Baileys.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjsPromise: Promise<any> | null = null;
function pdfjs(): Promise<any> {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

type Row = Record<string, unknown>;

const VENDOR = "Amazon Seller Services Pvt. Ltd.";

/** Extract page text as x-sorted lines joined by " ". */
export async function pdfToLines(buf: Buffer): Promise<string[]> {
  const { getDocument } = await pdfjs();
  const doc = await getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as any[]) {
      if (typeof it.str !== "string") continue;
      const y = Math.round(it.transform[5]);
      let bucket = byY.get(y);
      if (!bucket) byY.set(y, (bucket = []));
      bucket.push({ x: it.transform[4], s: it.str });
    }
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      lines.push(
        byY
          .get(y)!
          .sort((a, b) => a.x - b.x)
          .map((o) => o.s)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      );
    }
  }
  return lines;
}

/** INR amount that may be prefixed with a minus (credit notes) and may carry
 *  the "INR" token; returns a signed number. */
const num = (s: string | undefined | null): number => {
  if (!s) return 0;
  const neg = /-\s*(?:INR|₹|\d)/.test(String(s)) || /^-/.test(String(s).trim());
  const n = Number(String(s).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
};

const isoDate = (s: string | undefined): string | null => {
  if (!s) return null;
  const m = s.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? "20" + m[3] : m[3];
  return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
};

function invoiceType(number: string, isCreditNote: boolean): string {
  const prefix = (number.split("-")[0] || "").toUpperCase();
  if (prefix === "ADS") return isCreditNote ? "Amazon Advertising (Credit Note)" : "Amazon Advertising";
  if (prefix === "KA" || prefix === "KAC")
    return isCreditNote ? "Amazon Services (Credit Note)" : "Amazon Services";
  return isCreditNote ? "Amazon Purchase (Credit Note)" : "Amazon Purchase";
}

export async function parseFeeInvoicePdf(buf: Buffer): Promise<Row[]> {
  const lines = await pdfToLines(buf);
  const text = lines.join("\n");

  const isCreditNote = /Credit Note Number:/i.test(text);
  const invoice_number =
    (text.match(/(?:Credit Note Number|Invoice Number):\s*([A-Z0-9-]+)/i) || [])[1]?.trim() || "";
  const invoice_date = isoDate(
    (text.match(/(?:Credit Note Date|Invoice Date):\s*([0-9/\-]+)/i) || [])[1]
  );
  const vendor_gstin =
    (text.match(/GST Tax Registration No:\s*([A-Z0-9]+)/i) || [])[1]?.trim() || null;
  const bill_to_name = (text.match(/Name:\s*([^\n*]+)/i) || [])[1]?.trim() || null;
  const bill_to_gstin = (text.match(/\bGSTIN:\s*([A-Z0-9]+)/i) || [])[1]?.trim() || null;
  const place_of_supply =
    (text.match(/Place of Supply:\s*([A-Za-z /]+?)(?:\s+State\/UT|$)/im) || [])[1]?.trim() || null;
  const total_invoice_amount = num(
    (text.match(/Total Invoice amount\s+(-?\s*INR\s+[\d,]+\.?\d*)/i) || [])[1]
  );
  const subtotal_fees = num(
    (text.match(/Subtotal of fees amount\s+(-?\s*INR\s+[\d,]+\.?\d*)/i) || [])[1]
  );
  const subtotal_igst = num(
    (text.match(/Subtotal for IGST\s+(-?\s*INR\s+[\d,]+\.?\d*)/i) || [])[1]
  );
  const inv_type = invoiceType(invoice_number, isCreditNote);

  const base = {
    invoice_number,
    invoice_date,
    vendor: VENDOR,
    vendor_gstin,
    bill_to_name,
    bill_to_gstin,
    place_of_supply,
    invoice_type: inv_type,
    cgst_rate: 0,
    cgst_amount: 0,
    sgst_rate: 0,
    sgst_amount: 0,
  };

  // ---- page-1 service-summary table ----
  // Invoice rows:      "1.  996812  Shipping Fee  INR 11.20"      then  "IGST  18.00%  INR 2.03"
  // Credit-note rows:  "1.  KA-2627-106762  04-30-2026  998599  Fixed Closing Fee  -INR 22.00"
  //                    then  "IGST  18.00%  -INR 3.96"
  // Amounts sometimes wrap to the next physical line ("-INR" then "280.00"), and
  // the description can precede its numbered line.
  const items: Row[] = [];
  const startIdx = lines.findIndex(
    (l) => /\bSI\b/i.test(l) && /Category of\s+Service|Category of Service/i.test(l)
  );
  const endIdx = lines.findIndex((l) => /^Total:\s+-?\s*INR/i.test(l) || /^-?INR$/i.test(l.trim()) && false);
  const stopIdx =
    lines.findIndex((l, i) => i > startIdx && /^Total:/i.test(l.trim())) ;
  if (startIdx >= 0 && stopIdx > startIdx) {
    // rejoin lines: a bare "-INR" / "INR" glues to the number on the next line
    const rawSeg = lines.slice(startIdx + 1, stopIdx).map((s) => s.trim()).filter(Boolean);
    const seg: string[] = [];
    for (let i = 0; i < rawSeg.length; i++) {
      const cur = rawSeg[i];
      if (/(?:-\s*INR|INR)$/i.test(cur) && i + 1 < rawSeg.length && /^[\d,]+\.?\d*$/.test(rawSeg[i + 1])) {
        seg.push(cur + " " + rawSeg[i + 1]);
        i++;
      } else {
        seg.push(cur);
      }
    }

    let pending: { code: string | null; desc: string; fee: number } | null = null;
    const flush = (igstRate: number, igstAmt: number) => {
      if (!pending) return;
      const fee = pending.fee;
      const igst =
        igstAmt || Math.round(((fee * igstRate) / 100) * 100) / 100;
      items.push({
        ...base,
        description: pending.desc || inv_type,
        category_code: pending.code || "",
        taxable_amount: fee,
        igst_rate: igstRate,
        igst_amount: igst,
        total_amount: Math.round((fee + igst) * 100) / 100,
      });
      pending = null;
    };

    const AMT = /(-?\s*INR\s+[\d,]+\.?\d*)/i;
    for (const l of seg) {
      const igst = l.match(/IGST\s+([\d.]+)%\s+(-?\s*INR\s+[\d,]+\.?\d*)/i);
      if (igst) {
        flush(num(igst[1]), num(igst[2]));
        continue;
      }
      // numbered line (invoice OR credit-note shape) — strip the SI number, an
      // optional "<origInv> <origDate>", grab the 6-digit code, desc, amount.
      const numbered = l.match(
        /^\d+\.\s+(?:[A-Z0-9-]+\s+[\d/\-]{8,10}\s+)?(\d{6})\s*(.*?)\s*(?:(-?\s*INR\s+[\d,]+\.?\d*))?$/i
      );
      if (numbered) {
        if (pending && !pending.code && !numbered[2] && !numbered[3]) {
          pending.code = numbered[1];
          continue;
        }
        flush(0, 0);
        pending = {
          code: numbered[1],
          desc: (numbered[2] || "").trim(),
          fee: numbered[3] ? num(numbered[3]) : 0,
        };
        continue;
      }
      // bare "<desc>  [-]INR <amt>" — description line that precedes its numbered line
      const descAmt = l.match(/^([A-Za-z][A-Za-z .\-/&]+?)\s+(-?\s*INR\s+[\d,]+\.?\d*)$/i);
      if (descAmt && AMT.test(descAmt[2])) {
        flush(0, 0);
        pending = { code: null, desc: descAmt[1].trim(), fee: num(descAmt[2]) };
        continue;
      }
    }
    flush(0, 0);
  }
  void endIdx;

  // Keep lines with a non-zero fee (credit notes are negative).
  const real = items.filter((r) => Number(r.taxable_amount) !== 0);
  if (real.length) return real;

  // ---- fallback: one summary record ----
  const taxable = subtotal_fees || total_invoice_amount;
  const igstAmt = subtotal_igst;
  return [
    {
      ...base,
      description: inv_type,
      category_code: "",
      taxable_amount: taxable,
      igst_rate: taxable ? Math.round((igstAmt / taxable) * 1000) / 10 : 18,
      igst_amount: igstAmt,
      total_amount: total_invoice_amount || Math.round((taxable + igstAmt) * 100) / 100,
    },
  ];
}
