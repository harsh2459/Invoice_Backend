/**
 * Sales Return / Credit Note PDF — lavender "Tax Invoice" family.
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

export function returnPdfFilename(r: { number?: string | null; id: number }): string {
  return `CreditNote_${(r.number || r.id).toString().replace(/[^\w-]/g, "_")}.pdf`;
}

export async function renderReturnPdf(returnId: number | string): Promise<{
  buffer: Buffer;
  filename: string;
  ret: any;
}> {
  const rows = await query<any>(
    `SELECT r.*, cl.name AS client_name, cl.address AS client_address, cl.phone AS client_phone,
            cl.gstin AS client_gstin,
            co.name AS company_name, co.phone AS company_phone, co.email AS company_email,
            co.gstin AS company_gstin, co.logo AS company_logo,
            i.number AS invoice_number
       FROM sales_returns r
       LEFT JOIN clients cl ON cl.id = r.client_id
       LEFT JOIN companies co ON co.id = r.company_id
       LEFT JOIN invoices i ON i.id = r.invoice_id
      WHERE r.id = ?`,
    [String(returnId)]
  );
  const r = rows[0];
  if (!r) {
    const err = new Error("Return not found") as Error & { code?: string };
    err.code = "RETURN_NOT_FOUND";
    throw err;
  }
  const items = await query<any>(
    "SELECT description, hsn, qty, rate, amount, gst_rate FROM sales_return_items WHERE sales_return_id = ? ORDER BY id",
    [String(returnId)]
  );
  // Current = ledger balance now. Previous = before this credit note was posted
  // (add its credit back).
  const currentBalance = await partyBalance("client", Number(r.client_id));
  const previousBalance = Math.round((currentBalance + Number(r.total)) * 100) / 100;
  const buffer = await draw(r, items, previousBalance, currentBalance);
  return { buffer, filename: returnPdfFilename(r), ret: r };
}

const REASON: Record<string, string> = {
  damaged: "Damaged",
  wrong_item: "Wrong item",
  excess: "Excess supply",
  not_needed: "Not needed",
  other: "Other",
};

function draw(
  r: any,
  items: any[],
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
  const hasHsn = items.some((it) => it.hsn && String(it.hsn).trim());
  const qtySum = items.reduce((s, it) => s + Number(it.qty || 0), 0);

  let y = left;
  y = masthead(d, co, "Sales Return / Credit Note", y);

  y = twoColBlock(
    d,
    y,
    "Return From",
    "Credit Note Details",
    [
      r.client_name || "—",
      r.client_phone ? `Contact No. : ${r.client_phone}` : "",
      r.client_address || "",
    ].filter(Boolean),
    [
      `Credit Note No. : ${r.number || r.id}`,
      `Date : ${ddmmyyyy(r.return_date)}`,
      r.invoice_number ? `Against : ${r.invoice_number}` : "",
      `Reason : ${REASON[r.reason] || r.reason}`,
      r.restock ? "Restocked : Yes" : "Restocked : No",
    ].filter(Boolean)
  );

  // items table
  type Col = { title: string; w: number; align: "left" | "right" | "center" };
  const cols: Col[] = [
    { title: "#", w: 26, align: "center" },
    { title: "Item name", w: 0, align: "left" },
    ...(hasHsn ? [{ title: "HSN/ SAC", w: 90, align: "left" as const }] : []),
    { title: "Qty", w: 70, align: "right" },
    { title: "Rate", w: 90, align: "right" },
    { title: "Amount", w: 90, align: "right" },
  ];
  const fixedW = cols.reduce((s, c) => s + c.w, 0);
  cols.find((c) => c.title === "Item name")!.w = contentW - fixedW;

  const head = (yy: number) => {
    band(d, yy, 16);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(BAND_TEXT);
    let cx = left;
    cols.forEach((c) => {
      doc.text(c.title, cx + 5, yy + 4.5, { width: c.w - 10, align: c.align });
      cx += c.w;
    });
    return yy + 16;
  };
  y = head(y);
  const tableTop = y;

  doc.font("Helvetica").fontSize(8.5).fillColor(INK);
  items.forEach((it: any, i: number) => {
    const ry = y;
    const cells = [
      String(i + 1),
      it.description || "",
      ...(hasHsn ? [it.hsn || ""] : []),
      String(Number(it.qty)),
      INR(Number(it.rate)),
      INR(Number(it.amount)),
    ];
    let cx = left;
    cells.forEach((txt, ci) => {
      const c = cols[ci];
      doc
        .font(ci === 1 ? "Helvetica-Bold" : "Helvetica")
        .fontSize(8.5)
        .fillColor(INK)
        .text(txt, cx + 5, ry + 4, { width: c.w - 10, align: c.align });
      cx += c.w;
    });
    y = ry + 18;
    rule(d, y);
  });

  // Total row
  {
    const ry = y;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK);
    doc.text("Total", left + cols[0].w + 5, ry + 4, { width: cols[1].w - 10 });
    let qx = left + cols[0].w + cols[1].w + (hasHsn ? cols[2].w : 0);
    const qCol = cols.find((c) => c.title === "Qty")!;
    doc.text(String(qtySum), qx + 5, ry + 4, { width: qCol.w - 10, align: "right" });
    const aCol = cols[cols.length - 1];
    doc.text(INR(r.total), right - aCol.w + 5, ry + 4, { width: aCol.w - 10, align: "right" });
    y = ry + 18;
  }
  let vx = left;
  for (const c of cols) {
    vline(d, vx, tableTop - 16, y);
    vx += c.w;
  }
  vline(d, right, tableTop - 16, y);
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor("#8C86D9").stroke();

  // amounts / words
  y = twoColBlock(
    d,
    y,
    "Credit Note Amount In Words",
    "Amounts",
    [amountInWords(Number(r.total)).replace(/^INR\s+/, "").replace(/\s+Only\.$/, " Rupees only")],
    [
      `Sub Total : ${INR(r.subtotal)}`,
      Number(r.tax_total) > 0 ? `Total GST : ${INR(r.tax_total)}` : "",
      `Credit Total : ${INR(r.total)}`,
    ].filter(Boolean),
    46
  );

  // account summary
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
    doc.text(k, left + 6, y + 4, { width: 200 });
    doc.text(v, left + 6, y + 4, { width: contentW - 12, align: "right" });
    y += strong ? 16 : 14;
  };
  sumLine("Previous Balance (before this credit note)", INR(previousBalance));
  sumLine("Less: Credit Note " + (r.number || ""), "- " + INR(Number(r.total)));
  sumLine("Current Balance (amount due)", INR(currentBalance), true, true);
  y = y + (sumH - 44); // align to box bottom

  // footer
  band(d, y);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT).text("Note", left + 6, y + 4);
  y += 15;
  const footH = 56;
  box(d, y, footH);
  vline(d, left + contentW / 2, y, y + footH);
  doc.font("Helvetica").fontSize(8).fillColor(INK).text(
    r.notes ? String(r.notes) : "Goods received back and credited to your account.",
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
