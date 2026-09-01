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

const BRAND = "#2f5496"; // header bar / accents (matches the reference invoice)
const INK = "#1f272e";
const MUTE = "#6b7280";
const HAIR = "#e4e7eb";
const ZEBRA = "#f4f6fb";
const PANEL = "#eef2fb";

export function invoicePdfFilename(inv: { number?: string | null; id: number }): string {
  return `Invoice_${(inv.number || inv.id).toString().replace(/[^\w-]/g, "_")}.pdf`;
}

/** Derive a human "Terms" string from invoice/due dates. */
function termsLabel(invoiceDate: any, dueDate: any): string {
  if (!dueDate) return "Due on Receipt";
  const a = new Date(String(invoiceDate).slice(0, 10));
  const b = new Date(String(dueDate).slice(0, 10));
  const days = Math.round((b.getTime() - a.getTime()) / 86400000);
  if (!Number.isFinite(days) || days <= 0) return "Due on Receipt";
  if (days === 15 || days === 30 || days === 45 || days === 60 || days === 90) return `Net ${days}`;
  return `Net ${days} days`;
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

  const buffer = await drawInvoice(inv, co, items);
  return { buffer, filename: invoicePdfFilename(inv), invoice: inv };
}

function drawInvoice(inv: any, co: any, items: any[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const total = Number(inv.total || 0);
    const paid = Number(inv.amount_paid || 0);
    const balance = Math.round((total - paid) * 100) / 100;
    const hasTax = items.some((it: any) => Number(it.tax_amount) > 0);
    const hasHsn = items.some((it: any) => it.hsn);
    const taxable = Number(inv.subtotal) - Number(inv.discount_value || 0);
    const blendedRate =
      hasTax && taxable > 0 ? Math.round((Number(inv.tax_total) / taxable) * 10000) / 100 : 0;

    const doc = new PDFDocument({ margin: 44, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const contentW = right - left;

    // ============ 1. brand rule + masthead ============
    doc.rect(left, doc.y, contentW, 4).fill(BRAND);
    const headTop = doc.y + 18;

    const LOGO = 84;
    let textX = left;
    let logoBottom = headTop;
    if (co.logo && typeof co.logo === "string" && co.logo.startsWith("data:image")) {
      try {
        const buf = Buffer.from(co.logo.split(",")[1], "base64");
        doc.image(buf, left, headTop, { fit: [LOGO, LOGO], align: "center", valign: "center" });
        textX = left + LOGO + 16;
        logoBottom = headTop + LOGO;
      } catch {
        /* bad image data — skip */
      }
    }
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(co.name || "Company", textX, headTop + 2, {
      width: contentW - (textX - left) - 200,
    });
    doc.font("Helvetica").fontSize(8).fillColor(MUTE).text(
      [
        co.address,
        [co.phone, co.email].filter(Boolean).join("  •  "),
        co.gstin ? `GSTIN: ${co.gstin}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      textX,
      headTop + 24,
      { width: contentW - (textX - left) - 200 }
    );

    doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(32);
    doc.text("INVOICE", right - 240, headTop - 6, { width: 240, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor(MUTE);
    doc.text(inv.number ? `# ${inv.number}` : `# ${inv.id}`, right - 240, headTop + 34, {
      width: 240,
      align: "right",
    });

    // ============ 2. meta grid (full-width boxed label:value pairs) ============
    const showTerms = !!inv.due_date;
    let y = Math.max(headTop + 70, logoBottom + 6) + 8;
    const metaRows: [string, string][] = [
      ["Invoice#", inv.number || `INV-${String(inv.id).padStart(6, "0")}`],
      ["Invoice Date", ddmmyyyy(inv.invoice_date)],
      ...((showTerms
        ? [
            ["Terms", termsLabel(inv.invoice_date, inv.due_date)],
            ["Due Date", ddmmyyyy(inv.due_date)],
          ]
        : []) as [string, string][]),
    ];
    const rh = 20;
    const cellW = contentW / metaRows.length;
    doc.rect(left, y, contentW, rh * 2).strokeColor(HAIR).lineWidth(1).stroke();
    doc.moveTo(left, y + rh).lineTo(right, y + rh).strokeColor(HAIR).stroke();
    metaRows.forEach(([k, v], i) => {
      const cxp = left + i * cellW;
      if (i) doc.moveTo(cxp, y).lineTo(cxp, y + rh * 2).strokeColor(HAIR).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(MUTE).text(k, cxp + 8, y + 6, { width: cellW - 16 });
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(INK)
        .text(v, cxp + 8, y + rh + 5, { width: cellW - 16 });
    });
    y += rh * 2 + 18;

    // ============ 3. Bill To / Ship To ============
    const partyTop = y;
    const halfW = contentW / 2 - 12;
    const shipX = left + contentW / 2 + 12;

    const party = (label: string, x: number, w: number) => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND).text(label, x, partyTop, { width: w });
      doc
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .fillColor(INK)
        .text(inv.client_name || "—", x, partyTop + 14, { width: w });
      const lines = [
        inv.client_address,
        inv.client_gstin ? `GSTIN: ${inv.client_gstin}` : "",
        [inv.client_phone, inv.client_email].filter(Boolean).join("  •  "),
      ].filter(Boolean);
      if (lines.length)
        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor(MUTE)
          .text(lines.join("\n"), x, partyTop + 28, { width: w });
    };
    party("Bill To", left, halfW);
    party("Ship To", shipX, halfW);

    y = partyTop + 86;
    doc.y = y;

    // ============ 4. items table ============
    const cols: { title: string; w: number; align: "left" | "right" | "center" }[] = [
      { title: "#", w: 24, align: "center" },
      ...(hasHsn ? [{ title: "HSN", w: 46, align: "left" as const }] : []),
      { title: "Item & Description", w: 0, align: "left" },
      { title: "Qty", w: 48, align: "right" },
      { title: "Rate", w: 72, align: "right" },
      ...(hasTax ? [{ title: "GST", w: 42, align: "right" as const }] : []),
      { title: "Amount", w: 78, align: "right" },
    ];
    const fixed = cols.reduce((s, c) => s + c.w, 0);
    cols.find((c) => c.title === "Item & Description")!.w = contentW - fixed;

    const headH = 22;
    const hy = doc.y;
    doc.rect(left, hy, contentW, headH).fill(BRAND);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5);
    let cx = left;
    cols.forEach((c) => {
      doc.text(c.title.toUpperCase(), cx + 6, hy + 7, { width: c.w - 12, align: c.align });
      cx += c.w;
    });
    doc.y = hy + headH;

    const bottom = () => doc.page.height - doc.page.margins.bottom - 4;
    items.forEach((it: any, i: number) => {
      const qty = Number(it.qty);
      const descLines = doc.heightOfString(it.description || "", {
        width: cols.find((c) => c.title === "Item & Description")!.w - 12,
        // measure at the body font size used below
      });
      const rowH = Math.max(26, 12 + descLines);
      if (doc.y + rowH > bottom()) doc.addPage();
      const ry = doc.y;
      if (i % 2 === 1) doc.rect(left, ry, contentW, rowH).fill(ZEBRA);

      const cells: { text: string; sub?: string }[] = [
        { text: String(i + 1) },
        ...(hasHsn ? [{ text: it.hsn || "" }] : []),
        { text: it.description || "" },
        { text: Number.isInteger(qty) ? String(qty) : qty.toString(), sub: "Piece" },
        { text: INR(Number(it.rate)) },
        ...(hasTax ? [{ text: `${Number(it.gst_rate)}%` }] : []),
        { text: INR(Number(it.amount)) },
      ];
      let x = left;
      cells.forEach((cell, ci) => {
        const c = cols[ci];
        doc.font("Helvetica").fontSize(8.5).fillColor(INK);
        doc.text(cell.text, x + 6, ry + 6, { width: c.w - 12, align: c.align });
        if (cell.sub) {
          doc.font("Helvetica").fontSize(7).fillColor(MUTE);
          doc.text(cell.sub, x + 6, ry + 17, { width: c.w - 12, align: c.align });
        }
        x += c.w;
      });
      doc.moveTo(left, ry + rowH).lineTo(right, ry + rowH).strokeColor(HAIR).lineWidth(1).stroke();
      doc.y = ry + rowH;
    });

    // ============ 5. totals panel ============
    doc.y += 14;
    const panelW = 240;
    const panelX = right - panelW;
    const lineH = 17;
    const totalLines: [string, string, boolean, string?][] = [
      ["Sub Total", INR(Number(inv.subtotal)), false],
    ];
    if (Number(inv.discount_value) > 0) {
      const dl = inv.discount_is_pct ? `Discount (${Number(inv.discount)}%)` : "Discount";
      totalLines.push([dl, "- " + INR(Number(inv.discount_value)), false]);
      totalLines.push(["Taxable", INR(taxable), false]);
    }
    if (hasTax) totalLines.push([`Tax Rate`, `${blendedRate}%`, false]);
    if (hasTax) totalLines.push([`Total GST`, INR(Number(inv.tax_total)), false]);
    totalLines.push(["Grand Total", INR(total), true, BRAND]);
    const isPaid = inv.payment_status === "paid" || balance <= 0.009;
    if (paid > 0) totalLines.push(["Amount Paid", "- " + INR(paid), false, "#1B9E5A"]);
    totalLines.push([
      isPaid ? "Amount Due" : "Balance Due",
      isPaid ? INR(0) : INR(balance),
      true,
      isPaid ? "#1B9E5A" : "#C0392B",
    ]);

    const panelH = lineH * totalLines.length + 10;
    if (doc.y + panelH + 24 > bottom()) doc.addPage();
    const py = doc.y;
    doc.rect(panelX, py, panelW, panelH).fill(PANEL);
    let ly = py + 6;
    totalLines.forEach(([k, v, strong, color]) => {
      doc
        .font(strong ? "Helvetica-Bold" : "Helvetica")
        .fontSize(strong ? 9.5 : 8.5)
        .fillColor(color || (strong ? BRAND : INK));
      doc.text(k, panelX + 12, ly + 3, { width: 110 });
      doc.text(v, panelX + 12, ly + 3, { width: panelW - 24, align: "right" });
      if (strong && k === "Grand Total")
        doc.moveTo(panelX + 12, ly).lineTo(panelX + panelW - 12, ly).strokeColor("#c9d4ec").stroke();
      ly += lineH;
    });

    // status word (plain text, no coloured bar)
    const statusY = py + panelH + 8;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(isPaid ? "#1B9E5A" : inv.payment_status === "partial" ? "#B87300" : "#C0392B");
    doc.text(
      isPaid
        ? "FULLY PAID"
        : inv.payment_status === "partial"
        ? `PAID ${INR(paid)}  •  DUE ${INR(balance)}`
        : `PAYMENT PENDING  •  ${INR(balance)}`,
      panelX + 12,
      statusY,
      { width: panelW - 24, align: "right" }
    );

    // amount in words (left column, aligned with the panel top)
    doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(MUTE);
    doc.text(`Amount in words: ${amountInWords(total)}`, left, py + 2, {
      width: contentW - panelW - 20,
    });

    doc.y = Math.max(statusY + 14, py + panelH) + 22;

    // ============ 6. footer — thanks · notes · terms ============
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(HAIR).stroke();
    doc.y += 10;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("Thanks for your business.", left, doc.y);
    doc.y += 16;

    if (inv.notes && String(inv.notes).trim()) {
      doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text("Notes / Additional Info", left, doc.y);
      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(MUTE)
        .text(String(inv.notes).trim(), left, doc.y + 11, { width: contentW });
      doc.y += 12;
    }

    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text("Terms & Conditions", left, doc.y);
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(MUTE)
      .text(
        "Full payment is due upon receipt of this invoice. Late payments may incur additional charges or interest as per applicable laws.",
        left,
        doc.y + 11,
        { width: contentW }
      );

    doc.end();
  });
}
