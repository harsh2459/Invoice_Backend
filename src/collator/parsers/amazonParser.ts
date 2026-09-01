/**
 * Amazon MTR CSV parser — port of Drogon `parsers/amazon_parser.py`.
 * Header names are mapped via COL_MAP; values cast by DT/INT/FLOAT sets.
 * `order_type` ("B2C"/"B2B") comes from the caller, not the file.
 * Output rows are plain objects keyed by col_amazon_mtr column names.
 */
import Papa from "papaparse";
import { sStr, sInt, sFloat, sDateTime } from "./cast";

// source CSV header -> col_amazon_mtr column
const COL_MAP: Record<string, string> = {
  "Seller Gstin": "seller_gstin",
  "Invoice Number": "invoice_number",
  "Invoice Date": "invoice_date",
  "Transaction Type": "transaction_type",
  "Order Id": "order_id",
  "Shipment Id": "shipment_id",
  "Shipment Date": "shipment_date",
  "Order Date": "order_date",
  "Shipment Item Id": "shipment_item_id",
  Quantity: "quantity",
  "Item Description": "item_description",
  Asin: "asin",
  "Hsn/sac": "hsn_sac",
  Sku: "sku",
  "Bill From State": "bill_from_state",
  "Ship From State": "ship_from_state",
  "Ship To City": "ship_to_city",
  "Ship To State": "ship_to_state",
  "Invoice Amount": "invoice_amount",
  "Tax Exclusive Gross": "tax_exclusive_gross",
  "Total Tax Amount": "total_tax_amount",
  "Cgst Rate": "cgst_rate",
  "Sgst Rate": "sgst_rate",
  "Igst Rate": "igst_rate",
  "Principal Amount": "principal_amount",
  "Cgst Tax": "cgst_tax",
  "Sgst Tax": "sgst_tax",
  "Igst Tax": "igst_tax",
  "Shipping Amount": "shipping_amount",
  "Item Promo Discount": "item_promo_discount",
  "Tcs Igst Amount": "tcs_igst_amount",
  "Tcs Cgst Amount": "tcs_cgst_amount",
  "Tcs Sgst Amount": "tcs_sgst_amount",
  "Fulfillment Channel": "fulfillment_channel",
  "Payment Method Code": "payment_method_code",
  "Credit Note No": "credit_note_no",
};

const DT_COLS = new Set(["invoice_date", "shipment_date", "order_date"]);
const INT_COLS = new Set(["quantity"]);
const FLOAT_COLS = new Set([
  "invoice_amount", "tax_exclusive_gross", "total_tax_amount",
  "cgst_rate", "sgst_rate", "igst_rate", "principal_amount",
  "cgst_tax", "sgst_tax", "igst_tax", "shipping_amount",
  "item_promo_discount", "tcs_igst_amount", "tcs_cgst_amount", "tcs_sgst_amount",
]);

export function parseAmazonCsv(
  buf: Buffer,
  orderType: "B2C" | "B2B"
): Record<string, unknown>[] {
  // utf-8-sig — strip BOM
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const rows: Record<string, unknown>[] = [];
  for (const raw of parsed.data) {
    if (!raw || typeof raw !== "object") continue;
    const obj: Record<string, unknown> = { order_type: orderType };
    for (const [srcHeader, col] of Object.entries(COL_MAP)) {
      if (!(srcHeader in raw)) continue;
      const v = raw[srcHeader];
      if (DT_COLS.has(col)) obj[col] = sDateTime(v);
      else if (INT_COLS.has(col)) obj[col] = sInt(v);
      else if (FLOAT_COLS.has(col)) obj[col] = sFloat(v);
      else obj[col] = sStr(v);
    }
    rows.push(obj);
  }
  return rows;
}
