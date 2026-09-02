/**
 * Payment Receipt PDF — lavender "Tax Invoice" family. Shows the amount received,
 * which invoices it settled, and the client's balance remaining.
 */
import { query } from "./db";
import { amountInWords } from "./pdf";
import { partyBalance } from "./ledger";
import {
  newDoc,
  collect,
  masthead,
  twoColBlock,
  band,
  box,
  vline,
  rule,
  pageBorder,
  INR,
  ddmmyyyy,
  BAND_TEXT,
  INK,
  MUTE,
} from "./pdfLavender";

const MODE_LABEL: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  bank: "Bank Transfer",
  cheque: "Cheque",
  card: "Card",
  other: "Other",
};

export function receiptPdfFilename(r: { number?: string | null; id: number }): string {
  return `Receipt_${(r.number || r.id).toString().replace(/[^\w-]/g, "_")}.pdf`;
}

export async function renderReceiptPdf(receiptId: number | string): Promise<{
  buffer: Buffer;
  filename: string;
  receipt: any;
}> {
  const rows = await query<any>(
    `SELECT r.*, cl.name AS client_name, cl.address AS client_address, cl.phone AS client_phone,
            cl.email AS client_email,
            co.name AS company_name, co.address AS company_address, co.phone AS company_phone,
            co.email AS company_email, co.gstin AS company_gstin, co.logo AS company_logo
       FROM client_receipts r
       LEFT JOIN clients cl ON cl.id = r.client_id
       LEFT JOIN companies co ON co.id = r.company_id
      WHERE r.id = ?`,
    [String(receiptId)]
  );
  const r = rows[0];
  if (!r) {
    const err = new Error("Receipt not found") as Error & { code?: string };
    err.code = "RECEIPT_NOT_FOUND";
    throw err;
  }

  const allocations = await query<any>(
    `SELECT ip.amount, i.number AS invoice_number, i.invoice_date,
            (i.total - i.amount_paid) AS balance_after
       FROM invoice_payments ip
       JOIN invoices i ON i.id = ip.invoice_id
      WHERE ip.receipt_id = ?
      ORDER BY i.invoice_date, i.id`,
    [String(receiptId)]
  );

  const currentBalance = await partyBalance("client", Number(r.client_id));
  // Previous = before this receipt's credit was posted (add it back, minus any advance kept).
  const applied = Math.round((Number(r.amount) - Number(r.unapplied || 0)) * 100) / 100;
  const previousBalance = Math.round((currentBalance + applied) * 100) / 100;

  const buffer = await draw(r, allocations, previousBalance, currentBalance);
  return { buffer, filename: receiptPdfFilename(r), receipt: r };
}

function draw(
  r: any,
  allocations: any[],
  previousBalance: number,
  currentBalance: number
): Promise<Buffer> {
  const d = newDoc();
  const { doc, left, right, contentW } = d;
  const done = collect(doc);

  const co = {
    name: r.company_name,
    phone: r.company_phone,
    email: r.company_email,
    gstin: r.company_gstin,
    logo: r.company_logo,
  };

  let y = left;
  y = masthead(d, co, "Payment Receipt", y);

  y = twoColBlock(
    d,
    y,
    "Received From",
    "Receipt Details",
    [
      r.client_name || "—",
      r.client_phone ? `Contact No. : ${r.client_phone}` : "",
      r.client_address || "",
    ].filter(Boolean),
    [
      `Receipt No. : ${r.number || r.id}`,
      `Date : ${ddmmyyyy(r.receipt_date)}`,
      `Mode : ${MODE_LABEL[r.mode] || "Cash"}`,
      r.reference ? `Ref : ${r.reference}` : "",
    ].filter(Boolean)
  );

  // amount received — big line
  band(d, y);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT).text("Amount Received", left + 6, y + 4);
  y += 15;
  box(d, y, 40);
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(INR(r.amount), left + 8, y + 8, {
    width: contentW - 16,
    align: "right",
  });
  doc.font("Helvetica").fontSize(8).fillColor(MUTE).text(
    amountInWords(Number(r.amount)).replace(/^INR\s+/, "").replace(/\s+Only\.$/, " Rupees only"),
    left + 8,
    y + 8,
    { width: contentW - 16 }
  );
  y += 40;

  // settled invoices table
  if (allocations.length) {
    band(d, y);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(BAND_TEXT);
    const c0 = left,
      c1 = left + 30,
      c2 = right - 300,
      c3 = right - 190,
      c4 = right - 95;
    doc.text("#", c0 + 5, y + 4);
    doc.text("Invoice", c1 + 5, y + 4);
    doc.text("Invoice Date", c2 + 5, y + 4, { width: 100 });
    doc.text("Applied", c3 + 5, y + 4, { width: 90, align: "right" });
    doc.text("Balance After", c4 + 5, y + 4, { width: 90, align: "right" });
    y += 15;
    doc.font("Helvetica").fontSize(8.5).fillColor(INK);
    allocations.forEach((a, i) => {
      doc.text(String(i + 1), c0 + 5, y + 4);
      doc.text(a.invoice_number || "", c1 + 5, y + 4);
      doc.text(ddmmyyyy(a.invoice_date), c2 + 5, y + 4, { width: 100 });
      doc.text(INR(a.amount), c3 + 5, y + 4, { width: 90, align: "right" });
      doc.text(INR(a.balance_after), c4 + 5, y + 4, { width: 90, align: "right" });
      y += 16;
      rule(d, y);
    });
    [c0, c1, c2, c3, c4, right].forEach((x) => vline(d, x, y - 16 * allocations.length - 15, y));
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor("#8C86D9").stroke();
  }

  if (Number(r.unapplied || 0) > 0.009) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTE).text(
      `Unapplied advance retained: ${INR(r.unapplied)}`,
      left + 6,
      y + 6
    );
    y += 16;
  }

  // account summary band
  y += 6;
  band(d, y);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT).text("Account Summary", left + 6, y + 4);
  y += 15;
  const sumH = 46;
  box(d, y, sumH);
  const sumLine = (k: string, v: string, strong = false, topBorder = false) => {
    if (topBorder)
      doc.moveTo(left + 6, y).lineTo(right - 6, y).lineWidth(0.6).strokeColor("#c9c4ec").stroke();
    doc
      .font(strong ? "Helvetica-Bold" : "Helvetica")
      .fontSize(strong ? 10 : 8.5)
      .fillColor(INK);
    doc.text(k, left + 6, y + 4, { width: 220 });
    doc.text(v, left + 6, y + 4, { width: contentW - 12, align: "right" });
    y += strong ? 16 : 14;
  };
  sumLine("Previous Balance (before this receipt)", INR(previousBalance));
  sumLine("Less: Payment Received", "- " + INR(r.amount));
  sumLine("Current Balance (amount due)", INR(currentBalance), true, true);

  // footer
  band(d, y);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT).text("Note", left + 6, y + 4);
  y += 15;
  const footH = 56;
  box(d, y, footH);
  vline(d, left + contentW / 2, y, y + footH);
  doc.font("Helvetica").fontSize(8).fillColor(INK).text(
    r.notes ? String(r.notes) : "Thank you for your payment.",
    left + 6,
    y + 8,
    { width: contentW / 2 - 12 }
  );
  doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(
    `For : ${(co.name || "Company").toUpperCase()}`,
    left + contentW / 2 + 6,
    y + 8,
    { width: contentW / 2 - 12, align: "center" }
  );
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(
    "Authorized Signatory",
    left + contentW / 2 + 6,
    y + footH - 16,
    { width: contentW / 2 - 12, align: "center" }
  );
  y += footH;

  pageBorder(d, y);
  doc.end();
  return done;
}
