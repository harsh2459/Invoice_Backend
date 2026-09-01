/**
 * Flipkart XLSX parser — port of Drogon `parsers/flipkart_parser.py`.
 * Reads sheets "Sales Report" and "Cash Back Report" by exact name; header
 * names have Flipkart's verbose forms with fallbacks (first present wins).
 */
import * as XLSX from "xlsx";
import { sStr, sInt, sFloat, sDateTime } from "./cast";

type Row = Record<string, unknown>;

function col(row: Row, ...names: string[]): unknown {
  for (const n of names) {
    if (n in row && row[n] !== null && row[n] !== undefined && row[n] !== "") return row[n];
  }
  return null;
}

function sheetRows(wb: XLSX.WorkBook, name: string): Row[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<Row>(ws, { defval: null, raw: true });
  // strip whitespace from header keys
  return rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) out[k.trim()] = v;
    return out;
  });
}

export function parseFlipkartXlsx(buf: Buffer): {
  sales: Row[];
  cashbacks: Row[];
} {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sales: Row[] = [];
  const cashbacks: Row[] = [];

  for (const row of sheetRows(wb, "Sales Report")) {
    sales.push({
      seller_gstin: sStr(col(row, "Seller GSTIN")),
      order_id: sStr(col(row, "Order ID")),
      order_item_id: sStr(col(row, "Order Item ID")),
      product_title: sStr(col(row, "Product Title/Description")),
      fsn: sStr(col(row, "FSN")),
      sku: sStr(col(row, "SKU")),
      hsn_code: sStr(col(row, "HSN Code")),
      event_type: sStr(col(row, "Event Type")),
      event_sub_type: sStr(col(row, "Event Sub Type")),
      order_type: sStr(col(row, "Order Type")),
      order_date: sDateTime(col(row, "Order Date")),
      invoice_date: sDateTime(col(row, "Buyer Invoice Date", "Invoice Date")),
      invoice_number: sStr(col(row, "Buyer Invoice ID", "Invoice Number")),
      quantity: sInt(col(row, "Item Quantity", "Quantity")),
      invoice_amount: sFloat(
        col(
          row,
          "Final Invoice Amount (Price after discount+Shipping Charges)",
          "Buyer Invoice Amount",
          "Invoice Amount"
        )
      ),
      taxable_value: sFloat(
        col(row, "Taxable Value (Final Invoice Amount -Taxes)", "Taxable Value")
      ),
      cgst_rate: sFloat(col(row, "CGST Rate")),
      sgst_rate: sFloat(col(row, "SGST Rate (or UTGST as applicable)", "SGST Rate")),
      igst_rate: sFloat(col(row, "IGST Rate")),
      cgst_amount: sFloat(col(row, "CGST Amount")),
      sgst_amount: sFloat(col(row, "SGST Amount (Or UTGST as applicable)", "SGST Amount")),
      igst_amount: sFloat(col(row, "IGST Amount")),
      tcs_amount: sFloat(col(row, "Total TCS Deducted", "TCS Amount")),
      ship_to_state: sStr(col(row, "Customer's Delivery State", "Ship To State")),
      fulfillment_type: sStr(col(row, "Fulfilment Type", "Fulfillment Type")),
    });
  }

  for (const row of sheetRows(wb, "Cash Back Report")) {
    cashbacks.push({
      seller_gstin: sStr(col(row, "Seller GSTIN")),
      order_id: sStr(col(row, "Order ID")),
      order_item_id: sStr(col(row, "Order Item ID")),
      document_type: sStr(col(row, "Document Type")),
      document_sub_type: sStr(col(row, "Document Sub Type")),
      credit_debit_note_id: sStr(col(row, "Credit Note ID/ Debit Note ID")),
      invoice_amount: sFloat(col(row, "Invoice Amount")),
      invoice_date: sDateTime(col(row, "Invoice Date")),
      taxable_value: sFloat(col(row, "Taxable Value")),
      cgst_rate: sFloat(col(row, "CGST Rate")),
      sgst_rate: sFloat(col(row, "SGST Rate (or UTGST as applicable)", "SGST Rate")),
      igst_rate: sFloat(col(row, "IGST Rate")),
      cgst_amount: sFloat(col(row, "CGST Amount")),
      sgst_amount: sFloat(col(row, "SGST Amount (Or UTGST as applicable)", "SGST Amount")),
      igst_amount: sFloat(col(row, "IGST Amount")),
    });
  }

  return { sales, cashbacks };
}
