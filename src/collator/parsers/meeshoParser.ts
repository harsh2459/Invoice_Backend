/**
 * Meesho parsers — port of Drogon `parsers/meesho_parser.py`.
 * sales / returns: .xlsx (first sheet), lowercase snake_case headers.
 * invoices: .xlsx, title-case headers with periods.
 * Orders_*.csv: a companion SKU lookup — no new rows, backfills existing ones.
 * NOTE: `end_customer_state` comes from column `end_customer_state_new`.
 */
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { sStr, sInt, sFloat, sDateTime } from "./cast";

type Row = Record<string, unknown>;

function firstSheetRows(buf: Buffer): Row[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return ws ? XLSX.utils.sheet_to_json<Row>(ws, { defval: null, raw: true }) : [];
}

const g = (r: Row, k: string) => r[k];

function baseMeeshoRow(r: Row, skuMap?: Map<string, { sku: string | null; product_name: string | null }>): Row {
  const subOrder = sStr(g(r, "sub_order_num"));
  const row: Row = {
    identifier: sStr(g(r, "identifier")),
    sup_name: sStr(g(r, "sup_name")),
    gstin: sStr(g(r, "gstin")),
    sub_order_num: subOrder,
    order_date: sDateTime(g(r, "order_date")),
    hsn_code: sStr(g(r, "hsn_code")),
    quantity: sInt(g(r, "quantity")),
    gst_rate: sFloat(g(r, "gst_rate")),
    total_taxable_sale_value: sFloat(g(r, "total_taxable_sale_value")),
    tax_amount: sFloat(g(r, "tax_amount")),
    total_invoice_value: sFloat(g(r, "total_invoice_value")),
    taxable_shipping: sFloat(g(r, "taxable_shipping")),
    end_customer_state: sStr(g(r, "end_customer_state_new")),
    manifest_date: sDateTime(g(r, "manifest_date")),
    transaction_type: sStr(g(r, "transaction_type")),
    financial_year: sInt(g(r, "financial_year")),
    month_number: sInt(g(r, "month_number")),
    sku: null,
    product_name: null,
  };
  if (skuMap && subOrder && skuMap.has(subOrder)) {
    const hit = skuMap.get(subOrder)!;
    row.sku = hit.sku;
    row.product_name = hit.product_name;
  }
  return row;
}

export function loadOrdersSkuMap(
  buf: Buffer
): Map<string, { sku: string | null; product_name: string | null }> {
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
  const map = new Map<string, { sku: string | null; product_name: string | null }>();
  for (const r of parsed.data) {
    const sub = sStr(g(r, "Sub Order No"));
    if (sub) map.set(sub, { sku: sStr(g(r, "SKU")), product_name: sStr(g(r, "Product Name")) });
  }
  return map;
}

export function parseMeeshoSales(
  buf: Buffer,
  skuMap?: Map<string, { sku: string | null; product_name: string | null }>
): Row[] {
  return firstSheetRows(buf).map((r) => {
    const row = baseMeeshoRow(r, skuMap);
    row.eco_tcs_gstin = sStr(g(r, "eco_tcs_gstin"));
    row.supplier_id = sStr(g(r, "supplier_id"));
    return row;
  });
}

export function parseMeeshoReturns(
  buf: Buffer,
  skuMap?: Map<string, { sku: string | null; product_name: string | null }>
): Row[] {
  return firstSheetRows(buf).map((r) => baseMeeshoRow(r, skuMap));
}

export function parseMeeshoInvoices(buf: Buffer): Row[] {
  return firstSheetRows(buf).map((r) => ({
    type: sStr(g(r, "Type")),
    order_date: sDateTime(g(r, "Order Date")),
    suborder_no: sStr(g(r, "Suborder No.")),
    product_description: sStr(g(r, "Product Description")),
    hsn: sStr(g(r, "HSN")),
    invoice_no: sStr(g(r, "Invoice No.")),
  }));
}
