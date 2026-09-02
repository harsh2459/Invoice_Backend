/**
 * Shared drawing primitives for the lavender "Tax Invoice" style documents
 * (sales invoice, payment receipt, account statement). Keeps them visually
 * identical.
 */
import { PDFDocument } from "./pdf";

export const BAND = "#8C86D9";
export const BAND_TEXT = "#ffffff";
export const INK = "#1f272e";
export const MUTE = "#5b616b";
export const HAIR = "#b9b5e6";
export const OUTER = "#8C86D9";

export const INR = (n: unknown): string =>
  "Rs. " + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export const ddmmyyyy = (v: unknown): string => {
  const iso = String(v || "").slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

export interface Doc {
  doc: PDFKit.PDFDocument;
  left: number;
  right: number;
  contentW: number;
  pageBottom: number;
}

export function newDoc(margin = 34): Doc {
  const doc = new PDFDocument({ margin, size: "A4" });
  return {
    doc,
    left: doc.page.margins.left,
    right: doc.page.width - doc.page.margins.right,
    contentW: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    pageBottom: doc.page.height - doc.page.margins.bottom,
  };
}

export const collect = (doc: PDFKit.PDFDocument): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

export function rule(d: Doc, y: number) {
  d.doc.moveTo(d.left, y).lineTo(d.right, y).lineWidth(0.7).strokeColor(HAIR).stroke();
}
export function vline(d: Doc, x: number, y1: number, y2: number) {
  d.doc.moveTo(x, y1).lineTo(x, y2).lineWidth(0.7).strokeColor(HAIR).stroke();
}
export function band(d: Doc, y: number, h = 15) {
  d.doc.rect(d.left, y, d.contentW, h).fill(BAND);
}
export function box(d: Doc, y: number, h: number) {
  d.doc.rect(d.left, y, d.contentW, h).lineWidth(0.8).strokeColor(OUTER).stroke();
}

/** Draw the shared masthead (logo left, company block right). Returns new y. */
export function masthead(d: Doc, co: any, title: string, y: number): number {
  const { doc, left, right, contentW } = d;
  doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(title, left, y, {
    width: contentW,
    align: "center",
  });
  y += 22;
  const headH = 62;
  box(d, y, headH);
  if (co?.logo && typeof co.logo === "string" && co.logo.startsWith("data:image")) {
    try {
      const buf = Buffer.from(co.logo.split(",")[1], "base64");
      doc.image(buf, left + 8, y + 8, { fit: [90, headH - 16] });
    } catch {
      /* skip */
    }
  }
  doc.font("Helvetica-Bold").fontSize(15).fillColor(INK).text(
    (co?.name || "Company").toUpperCase(),
    right - 320,
    y + 12,
    { width: 312, align: "right" }
  );
  doc.font("Helvetica").fontSize(8).fillColor(MUTE).text(
    [co?.phone ? `Phone no.: ${co.phone}` : "", co?.email ? `Email: ${co.email}` : ""]
      .filter(Boolean)
      .join("   "),
    right - 320,
    y + 33,
    { width: 312, align: "right" }
  );
  if (co?.gstin)
    doc.text(`GSTIN: ${co.gstin}`, right - 320, y + 44, { width: 312, align: "right" });
  return y + headH;
}

/** Two-column band + box: left label/lines, right label/lines. Returns new y. */
export function twoColBlock(
  d: Doc,
  y: number,
  leftLabel: string,
  rightLabel: string,
  leftLines: string[],
  rightLines: string[],
  boxH = 50
): number {
  const { doc, left, contentW } = d;
  band(d, y);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BAND_TEXT);
  doc.text(leftLabel, left + 6, y + 4);
  doc.text(rightLabel, left + contentW / 2 + 6, y + 4, {
    width: contentW / 2 - 12,
    align: "right",
  });
  y += 15;
  box(d, y, boxH);
  vline(d, left + contentW / 2, y, y + boxH);
  doc.font("Helvetica").fontSize(8.5).fillColor(INK);
  doc.text(leftLines.join("\n"), left + 6, y + 6, { width: contentW / 2 - 12 });
  doc.text(rightLines.join("\n"), left + contentW / 2 + 6, y + 6, {
    width: contentW / 2 - 12,
    align: "right",
  });
  return y + boxH;
}

/** Outer page border around everything drawn so far (call last). */
export function pageBorder(d: Doc, bottomY: number) {
  d.doc
    .rect(d.left - 4, d.left - 4, d.contentW + 8, bottomY - (d.left - 4) + 6)
    .lineWidth(1)
    .strokeColor(OUTER)
    .stroke();
}
