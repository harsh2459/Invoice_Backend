import PDFDocument from "pdfkit";

/** `dd/mm/yyyy` from an ISO string or Date. */
export const ddmmyyyy = (d: any): string => {
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

/** Indian-locale rupees for PDF text (ASCII "Rs." — pdfkit's core fonts lack ₹). */
export const INR = (n: number): string =>
  "Rs. " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

/**
 * Draw a simple fixed-width table at the current `doc.y`. Naive page-break:
 * starts a new page when a row would overflow the bottom margin.
 */
export function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: (string | number)[][],
  colWidths: number[]
) {
  const startX = doc.page.margins.left;
  const rowHeight = 20;
  let y = doc.y;

  const drawRow = (cells: (string | number)[], bold: boolean) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.y;
    }
    let x = startX;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    cells.forEach((cell, i) => {
      doc.text(String(cell), x + 2, y + 5, { width: colWidths[i] - 4, ellipsis: true });
      x += colWidths[i];
    });
    doc
      .moveTo(startX, y + rowHeight)
      .lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y + rowHeight)
      .strokeColor("#dddddd")
      .stroke();
    y += rowHeight;
  };

  drawRow(headers, true);
  rows.forEach((r) => drawRow(r, false));
  doc.y = y + 10;
  doc.x = startX;
}

// ---- amount in words (Indian numbering) ----

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return (TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "")).trim();
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? ONES[h] + " Hundred" : "", rest ? twoDigits(rest) : ""].filter(Boolean).join(" ");
}

/** "INR One Thousand Two Hundred Thirty Four and 50/100 Only" style, Indian units. */
export function amountInWords(amount: number): string {
  const rupees = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - rupees) * 100);

  if (rupees === 0 && paise === 0) return "INR Zero Only.";

  const parts: string[] = [];
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const hundred = rupees % 1000;

  if (crore) parts.push(twoDigits(crore) + " Crore");
  if (lakh) parts.push(twoDigits(lakh) + " Lakh");
  if (thousand) parts.push(twoDigits(thousand) + " Thousand");
  if (hundred) parts.push(threeDigits(hundred));

  let words = "INR " + parts.join(" ");
  if (paise) words += ` and ${paise}/100`;
  return words + " Only.";
}

export { PDFDocument };
