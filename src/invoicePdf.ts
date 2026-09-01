/**
 * Invoice A4 PDF generation. Single source of truth for the download route
 * (routes/invoices.ts) and the WhatsApp send (routes/whatsapp.ts).
 *
 * `renderInvoicePdf(id)` loads the invoice + company + items and resolves to a
 * PDF Buffer. `invoicePdfFilename(inv)` gives the download filename both places
 * should use.
 *
 * Layout is modelled on a modern SaaS invoice: a full-width brand rule, a large
 * "INVOICE" wordmark, a boxed meta grid (Invoice#, Date, Terms, Due Date),
 * Bill To / Ship To columns, a dark header items table with zebra rows and a
 * unit line under each item, then a tinted totals panel ending in Balance Due.
 */
import { query } from "./db";
import { PDFDocument, ddmmyyyy, INR, amountInWords } from "./pdf";
import { previousClientBalance } from "./invoiceMath";

const BAND = "#8C86D9"; // lavender section bands (matches the reference invoice)
const BAND_TEXT = "#ffffff";
const INK = "#1f272e";
const MUTE = "#5b616b";
const HAIR = "#b9b5e6"; // grid lines inside the table
const OUTER = "#8C86D9"; // page border

export function invoicePdfFilename(inv: { number?: string | null; id: number }): string {
  return `Invoice_${(inv.number || inv.id).toString().replace(/[^\w-]/g, "_")}.pdf`;
}

/** Load an invoice and draw its PDF. Rejects with a tagged error when not found. */
export async function renderInvoicePdf(invoiceId: number | string | string[]): Promise<{
  buffer: Buffer;
  filename: string;
  invoice: any;
}> {
  const invRows = await query<any>(
    `SELECT i.*, cl.name AS client_name, cl.address AS client_address, cl.gstin AS client_gstin,
            cl.phone AS client_phone, cl.email AS client_email
     FROM invoices i
     LEFT JOIN clients cl ON cl.id = i.client_id
     WHERE i.id = ?`,
    [String(invoiceId)]
  );
  const inv = invRows[0];
  if (!inv) {
    const err = new Error("Invoice not found") as Error & { code?: string };
    err.code = "INVOICE_NOT_FOUND";
    throw err;
  }
  const coRows = await query<any>(
    "SELECT name, address, phone, email, gstin, logo FROM companies WHERE id = ?",
    [inv.company_id]
  );
  const co = coRows[0] || {};
  const items = await query<any>(
    "SELECT description, hsn, qty, rate, amount, gst_rate, tax_amount FROM invoice_items WHERE invoice_id = ? ORDER BY id",
    [String(invoiceId)]
  );

  const prevBalance = await previousClientBalance(
    { query },
    { clientId: inv.client_id, invoiceDate: String(inv.invoice_date).slice(0, 10), invoiceId: inv.id }
  );

  const buffer = await drawInvoice(inv, co, items, prevBalance);
  return { buffer, filename: invoicePdfFilename(inv), invoice: inv };
}

function drawInvoice(inv: any, co: any, items: any[], prevBalance = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const total = Number(inv.total || 0);
    const paid = Number(inv.amount_paid || 0);
    const balance = Math.round((total - paid) * 100) / 100;
    const currentBalance = Math.round((prevBalance + balance) * 100) / 100;
    // HSN column only when at least one line actually has an HSN/SAC.
    const hasHsn = items.some((it: any) => it.hsn && String(it.hsn).trim());
    const qtySum = items.reduce((s: number, it: any) => s + Number(it.qty || 0), 0);

    const doc = new PDFDocument({ margin: 34, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const contentW = right - left;
    const pageBottom = doc.page.height - doc.page.margins.bottom;

    const rule = (yy: number) =>
      doc.moveTo(left, yy).lineTo(right, yy).lineWidth(0.7).strokeColor(HAIR).stroke();
    const vline = (xx: number, y1: number, y2: number) =>
      doc.moveTo(xx, y1).lineTo(xx, y2).lineWidth(0.7).strokeColor(HAIR).stroke();
    const band = (yy: number, h: number) => doc.rect(left, yy, contentW, h).fill(BAND);

    // ---- title ----
    let y = left; // top margin
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text("Tax Invoice", left, y, {
      width: contentW,
      align: "center",
    });
    y += 22;

    // ---- masthead box: logo left, company block right ----
    const headTop = y;
    const headH = 62;
    doc.rect(left, headTop, contentW, headH).lineWidth(0.8).strokeColor(OUTER).stroke();
    if (co.logo && typeof co.logo === "string" && co.logo.startsWith("data:image")) {
      try {
        const buf = Buffer.from(co.logo.split(",")[1], "base64");
        doc.image(buf, left + 8, headTop + 8, { fit: [90, headH - 16] });
      } catch {
        /* skip bad image */
      }
    }
    doc.font("Helvetica-Bold").fontSize(15).fillColor(INK).text(
      (co.name || "Company").toUpperCase(),
      right - 320,
      headTop + 12,
      { width: 312, align: "right" }
    );
    doc.font("Helvetica").fontSize(8).fillColor(MUTE).text(
      [
        co.phone ? `Phone no.: ${co.phone}` : "",
        co.email ? `Email: ${co.email}` : "",
      ]
        .filter(Boolean)
        .join("   "),
      right - 320,
      headTop + 33,
      { width: 312, align: "right" }
    );
    if (co.gstin) {
      doc.text(`GSTIN: ${co.gstin}`, right - 320, headTop + 44, { width: 312, align: "right" });
    }
    y = headTop + headH;

    // ---- Bill To | Invoice Details band ----
    const bandH = 15;
    band(y, bandH);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT);
    doc.text("Bill To", left + 6, y + 4);
    doc.text("Invoice Details", left + contentW / 2 + 6, y + 4, {
      width: contentW / 2 - 12,
      align: "right",
    });
    y += bandH;

    const partyH = 50;
    doc.rect(left, y, contentW, partyH).lineWidth(0.8).strokeColor(OUTER).stroke();
    vline(left + contentW / 2, y, y + partyH);
    // left: client
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(inv.client_name || "—", left + 6, y + 5, {
      width: contentW / 2 - 12,
    });
    doc.font("Helvetica").fontSize(8).fillColor(MUTE);
    const clientLines = [
      inv.client_phone ? `Contact No. : ${inv.client_phone}` : "",
      inv.client_address || "",
      inv.client_gstin ? `GSTIN : ${inv.client_gstin}` : "",
    ].filter(Boolean);
    doc.text(clientLines.join("\n"), left + 6, y + 18, { width: contentW / 2 - 12 });
    // right: invoice no + date
    const rx = left + contentW / 2 + 6;
    const rw = contentW / 2 - 12;
    doc.font("Helvetica").fontSize(8.5).fillColor(INK);
    doc.text(`Invoice No. : ${inv.number || inv.id}`, rx, y + 8, { width: rw, align: "right" });
    doc.text(`Date : ${ddmmyyyy(inv.invoice_date)}`, rx, y + 22, { width: rw, align: "right" });
    if (inv.due_date)
      doc.text(`Due : ${ddmmyyyy(inv.due_date)}`, rx, y + 33, { width: rw, align: "right" });
    y += partyH;

    // ---- items table ----
    type Col = { title: string; w: number; align: "left" | "right" | "center" };
    const cols: Col[] = [
      { title: "#", w: 26, align: "center" },
      { title: "Item name", w: 0, align: "left" },
      ...(hasHsn ? [{ title: "HSN/ SAC", w: 90, align: "left" as const }] : []),
      { title: "Quantity", w: 78, align: "right" },
      { title: "Price/ Unit", w: 90, align: "right" },
      { title: "Amount", w: 90, align: "right" },
    ];
    const fixedW = cols.reduce((s, c) => s + c.w, 0);
    cols.find((c) => c.title === "Item name")!.w = contentW - fixedW;

    const drawHead = (yy: number) => {
      const hH = 16;
      band(yy, hH);
      doc.font("Helvetica-Bold").fontSize(8).fillColor(BAND_TEXT);
      let cx = left;
      cols.forEach((c) => {
        doc.text(c.title, cx + 5, yy + 4.5, { width: c.w - 10, align: c.align });
        cx += c.w;
      });
      return yy + hH;
    };
    y = drawHead(y);
    const tableLeftEdge = y;

    doc.font("Helvetica").fontSize(8.5).fillColor(INK);
    items.forEach((it: any, i: number) => {
      const qty = Number(it.qty || 0);
      const nameW = cols[1].w - 10;
      const nameH = doc.heightOfString(it.description || "", { width: nameW });
      const rowH = Math.max(18, nameH + 8);
      if (y + rowH > pageBottom - 40) {
        doc.addPage();
        y = left;
        y = drawHead(y);
      }
      const ry = y;
      const cells = [
        String(i + 1),
        it.description || "",
        ...(hasHsn ? [it.hsn || ""] : []),
        Number.isInteger(qty) ? String(qty) : String(qty),
        INR(Number(it.rate || 0)),
        INR(Number(it.amount || 0)),
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
      y = ry + rowH;
      rule(y);
    });

    // Total row
    {
      const rowH = 18;
      if (y + rowH > pageBottom - 40) {
        doc.addPage();
        y = left;
      }
      const ry = y;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK);
      doc.text("Total", left + cols[0].w + 5, ry + 4, { width: cols[1].w - 10 });
      // qty column
      let qx = left + cols[0].w + cols[1].w + (hasHsn ? cols[2].w : 0);
      const qCol = cols.find((c) => c.title === "Quantity")!;
      doc.text(
        Number.isInteger(qtySum) ? String(qtySum) : String(qtySum),
        qx + 5,
        ry + 4,
        { width: qCol.w - 10, align: "right" }
      );
      const aCol = cols[cols.length - 1];
      doc.text(INR(total), right - aCol.w + 5, ry + 4, { width: aCol.w - 10, align: "right" });
      y = ry + rowH;
    }

    // vertical rules + outer border for the whole table
    let vx = left;
    for (let i = 0; i < cols.length; i++) {
      vline(vx, tableLeftEdge - 16, y);
      vx += cols[i].w;
    }
    vline(right, tableLeftEdge - 16, y);
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(OUTER).stroke();

    // ---- Invoice Amount In Words | Amounts ----
    band(y, bandH);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT);
    doc.text("Invoice Amount In Words", left + 6, y + 4);
    doc.text("Amounts", left + contentW / 2 + 6, y + 4);
    y += bandH;

    const amtRows: [string, string, boolean][] = [
      ["Sub Total", INR(Number(inv.subtotal || total)), false],
    ];
    if (Number(inv.discount_value) > 0) {
      const dl = inv.discount_is_pct ? `Discount (${Number(inv.discount)}%)` : "Discount";
      amtRows.push([dl, "- " + INR(Number(inv.discount_value)), false]);
    }
    if (Number(inv.tax_total) > 0) amtRows.push(["Total GST", INR(Number(inv.tax_total)), false]);
    amtRows.push(["Total", INR(total), true]);
    amtRows.push(["Received", INR(paid), false]);
    amtRows.push(["Balance", INR(balance), true]);

    const amtRowH = 15;
    const amtBlockH = amtRows.length * amtRowH + (prevBalance > 0.009 ? amtRowH * 2 + 4 : 0) + 6;
    const wordsH = Math.max(
      amtBlockH,
      doc.heightOfString(`${amountInWords(total)}`, { width: contentW / 2 - 12 }) + 24
    );
    doc.rect(left, y, contentW, wordsH).lineWidth(0.8).strokeColor(OUTER).stroke();
    vline(left + contentW / 2, y, y + wordsH);

    // words (left)
    doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(
      amountInWords(total).replace(/^INR\s+/, "").replace(/\s+Only\.$/, " Rupees only"),
      left + 6,
      y + 8,
      { width: contentW / 2 - 12 }
    );

    // amounts (right)
    const ax = left + contentW / 2;
    let ay = y + 4;
    const amtLine = (k: string, v: string, strong: boolean, topBorder = false) => {
      if (topBorder) doc.moveTo(ax, ay).lineTo(right, ay).lineWidth(0.6).strokeColor(HAIR).stroke();
      doc
        .font(strong ? "Helvetica-Bold" : "Helvetica")
        .fontSize(8.5)
        .fillColor(INK);
      doc.text(k, ax + 6, ay + 3.5, { width: 120 });
      doc.text(v, ax + 6, ay + 3.5, { width: contentW / 2 - 12, align: "right" });
      ay += amtRowH;
    };
    amtRows.forEach(([k, v, s], i) => amtLine(k, v, s, i > 0));
    if (prevBalance > 0.009) {
      ay += 4;
      amtLine("Previous Balance", INR(prevBalance), false, true);
      amtLine("Current Balance", INR(currentBalance), true, false);
    }
    y += wordsH;

    // ---- Terms and Conditions band + signatory ----
    band(y, bandH);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT).text("Terms and Conditions", left + 6, y + 4);
    y += bandH;

    const footH = 70;
    doc.rect(left, y, contentW, footH).lineWidth(0.8).strokeColor(OUTER).stroke();
    vline(left + contentW / 2, y, y + footH);
    doc.font("Helvetica").fontSize(8).fillColor(INK).text(
      inv.notes && String(inv.notes).trim()
        ? String(inv.notes).trim()
        : "Thanks for doing business with us!",
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

    // ---- full outer page border ----
    doc
      .rect(left - 4, left - 4, contentW + 8, y - (left - 4) + 6)
      .lineWidth(1)
      .strokeColor(OUTER)
      .stroke();

    doc.end();
  });
}
