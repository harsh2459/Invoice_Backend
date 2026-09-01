/**
 * Collator module schema — marketplace statement ingestion + Tally-style ledger.
 * Ported from the standalone "Drogon" Postgres app. Called from db.ts initDb().
 *
 * All tables prefixed `col_` to avoid clashing with Tracker's own tables
 * (Tracker already has `purchase_invoices`, `suppliers`, `bank_accounts`, `wa_*`).
 * `companies` is SHARED with the Invoicing module (extended with short_code/active/color).
 *
 * Type mapping from the Python/SQLAlchemy models:
 *   Float    -> DECIMAL(14,2)     DateTime -> DATETIME
 *   Boolean  -> TINYINT(1)        Date     -> DATE
 *   Integer  -> INT               String(n)-> VARCHAR(n)   Text -> TEXT
 *
 * Period model (kept as-is from Drogon, intentionally inconsistent):
 *   Amazon / Flipkart / fee-invoices / bank  -> user-supplied data_month + data_year
 *   Meesho                                    -> the file's own financial_year + month_number
 */
import type { Pool } from "mysql2/promise";

// Tally's standard chart-of-accounts groups (name, nature). Seeded if absent.
export const DEFAULT_LEDGER_GROUPS: [string, string][] = [
  ["Bank Accounts", "asset"],
  ["Bank OCC A/c", "liability"],
  ["Bank OD A/c", "liability"],
  ["Branch / Divisions", "asset"],
  ["Capital Account", "liability"],
  ["Cash-in-Hand", "asset"],
  ["Current Assets", "asset"],
  ["Current Liabilities", "liability"],
  ["Deposits (Asset)", "asset"],
  ["Direct Expenses", "expense"],
  ["Direct Incomes", "income"],
  ["Duties & Taxes", "liability"],
  ["Expenses (Direct)", "expense"],
  ["Expenses (Indirect)", "expense"],
  ["Fixed Assets", "asset"],
  ["Income (Direct)", "income"],
  ["Income (Indirect)", "income"],
  ["Indirect Expenses", "expense"],
  ["Indirect Incomes", "income"],
  ["Investments", "asset"],
  ["Loans & Advances (Asset)", "asset"],
  ["Loans (Liability)", "liability"],
  ["Misc. Expenses (ASSET)", "asset"],
  ["Provisions", "liability"],
  ["Purchase Accounts", "expense"],
  ["Reserves & Surplus", "liability"],
  ["Retained Earnings", "liability"],
  ["Sales Accounts", "income"],
  ["Secured Loans", "liability"],
  ["Stock-in-Hand", "asset"],
  ["Sundry Creditors", "liability"],
  ["Sundry Debtors", "asset"],
  ["Suspense A/c", "asset"],
  ["Unsecured Loans", "liability"],
];

export async function initCollatorSchema(pool: Pool): Promise<void> {
  const idx = (sql: string) => pool.query(sql).catch(() => {});

  // ---- Ledger tables first (col_bank_txns FKs col_ledgers) ----

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_ledger_groups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      nature VARCHAR(20) NOT NULL DEFAULT 'expense',
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_ledgers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      group_id INT NOT NULL,
      color VARCHAR(10) NOT NULL DEFAULT '#1a6fd4',
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_colledger_group FOREIGN KEY (group_id) REFERENCES col_ledger_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colledgers_group ON col_ledgers (group_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_ledger_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ledger_id INT NOT NULL,
      keyword VARCHAR(150) NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_colrule_ledger FOREIGN KEY (ledger_id) REFERENCES col_ledgers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colrules_ledger ON col_ledger_rules (ledger_id)`);

  // ---- Import log ----

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_import_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      file_path VARCHAR(500),
      file_name VARCHAR(255),
      file_type VARCHAR(20),
      platform VARCHAR(30),
      rows_imported INT NOT NULL DEFAULT 0,
      status VARCHAR(20),
      error_message TEXT,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      file_size INT,
      checksum VARCHAR(64),
      company_id INT,
      data_month INT,
      data_year INT,
      CONSTRAINT fk_colimport_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colimport_checksum ON col_import_logs (checksum)`);
  await idx(`CREATE INDEX idx_colimport_company ON col_import_logs (company_id)`);

  // ---- Amazon MTR ----

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_amazon_mtr (
      id INT AUTO_INCREMENT PRIMARY KEY,
      seller_gstin VARCHAR(40),
      invoice_number VARCHAR(100),
      invoice_date DATETIME,
      transaction_type VARCHAR(30),
      order_id VARCHAR(100),
      shipment_id VARCHAR(100),
      shipment_date DATETIME,
      order_date DATETIME,
      shipment_item_id VARCHAR(100),
      quantity INT,
      item_description TEXT,
      asin VARCHAR(30),
      hsn_sac VARCHAR(30),
      sku VARCHAR(100),
      bill_from_state VARCHAR(100),
      ship_from_state VARCHAR(100),
      ship_to_city VARCHAR(100),
      ship_to_state VARCHAR(100),
      invoice_amount DECIMAL(14,2),
      tax_exclusive_gross DECIMAL(14,2),
      total_tax_amount DECIMAL(14,2),
      cgst_rate DECIMAL(14,2),
      sgst_rate DECIMAL(14,2),
      igst_rate DECIMAL(14,2),
      principal_amount DECIMAL(14,2),
      cgst_tax DECIMAL(14,2),
      sgst_tax DECIMAL(14,2),
      igst_tax DECIMAL(14,2),
      shipping_amount DECIMAL(14,2),
      item_promo_discount DECIMAL(14,2),
      tcs_igst_amount DECIMAL(14,2),
      tcs_cgst_amount DECIMAL(14,2),
      tcs_sgst_amount DECIMAL(14,2),
      fulfillment_channel VARCHAR(30),
      payment_method_code VARCHAR(30),
      credit_note_no VARCHAR(100),
      order_type VARCHAR(10),
      data_month INT,
      data_year INT,
      source_file TEXT,
      company_id INT,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_colamz_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colamz_order ON col_amazon_mtr (order_id)`);
  await idx(`CREATE INDEX idx_colamz_orderdate ON col_amazon_mtr (order_date)`);
  await idx(`CREATE INDEX idx_colamz_asin ON col_amazon_mtr (asin)`);
  await idx(`CREATE INDEX idx_colamz_sku ON col_amazon_mtr (sku)`);
  await idx(`CREATE INDEX idx_colamz_company ON col_amazon_mtr (company_id)`);
  await idx(`CREATE INDEX idx_colamz_period ON col_amazon_mtr (data_year, data_month)`);

  // ---- Flipkart ----

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_flipkart_sales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      seller_gstin VARCHAR(40),
      order_id VARCHAR(100),
      order_item_id VARCHAR(100),
      product_title TEXT,
      fsn VARCHAR(100),
      sku VARCHAR(100),
      hsn_code VARCHAR(30),
      event_type VARCHAR(80),
      event_sub_type VARCHAR(80),
      order_type VARCHAR(40),
      order_date DATETIME,
      invoice_date DATETIME,
      invoice_number VARCHAR(100),
      quantity INT,
      invoice_amount DECIMAL(14,2),
      taxable_value DECIMAL(14,2),
      cgst_rate DECIMAL(14,2),
      sgst_rate DECIMAL(14,2),
      igst_rate DECIMAL(14,2),
      cgst_amount DECIMAL(14,2),
      sgst_amount DECIMAL(14,2),
      igst_amount DECIMAL(14,2),
      tcs_amount DECIMAL(14,2),
      ship_to_state VARCHAR(100),
      fulfillment_type VARCHAR(40),
      data_month INT,
      data_year INT,
      source_file TEXT,
      company_id INT,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_colfk_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colfk_order ON col_flipkart_sales (order_id)`);
  await idx(`CREATE INDEX idx_colfk_orderdate ON col_flipkart_sales (order_date)`);
  await idx(`CREATE INDEX idx_colfk_sku ON col_flipkart_sales (sku)`);
  await idx(`CREATE INDEX idx_colfk_fsn ON col_flipkart_sales (fsn)`);
  await idx(`CREATE INDEX idx_colfk_company ON col_flipkart_sales (company_id)`);
  await idx(`CREATE INDEX idx_colfk_period ON col_flipkart_sales (data_year, data_month)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_flipkart_cashback (
      id INT AUTO_INCREMENT PRIMARY KEY,
      seller_gstin VARCHAR(40),
      order_id VARCHAR(100),
      order_item_id VARCHAR(100),
      document_type VARCHAR(80),
      document_sub_type VARCHAR(80),
      credit_debit_note_id VARCHAR(100),
      invoice_amount DECIMAL(14,2),
      invoice_date DATETIME,
      taxable_value DECIMAL(14,2),
      cgst_rate DECIMAL(14,2),
      sgst_rate DECIMAL(14,2),
      igst_rate DECIMAL(14,2),
      cgst_amount DECIMAL(14,2),
      sgst_amount DECIMAL(14,2),
      igst_amount DECIMAL(14,2),
      data_month INT,
      data_year INT,
      source_file TEXT,
      company_id INT,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_colfkcb_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colfkcb_order ON col_flipkart_cashback (order_id)`);
  await idx(`CREATE INDEX idx_colfkcb_company ON col_flipkart_cashback (company_id)`);

  // ---- Meesho (period = financial_year + month_number, NOT data_*) ----

  const meeshoCols = `
      identifier VARCHAR(100),
      sup_name VARCHAR(200),
      gstin VARCHAR(40),
      sub_order_num VARCHAR(150),
      order_date DATETIME,
      hsn_code VARCHAR(30),
      quantity INT,
      gst_rate DECIMAL(14,2),
      total_taxable_sale_value DECIMAL(14,2),
      tax_amount DECIMAL(14,2),
      total_invoice_value DECIMAL(14,2),
      taxable_shipping DECIMAL(14,2),
      end_customer_state VARCHAR(100),
      manifest_date DATETIME,
      transaction_type VARCHAR(50),
      financial_year INT,
      month_number INT,
      sku VARCHAR(150),
      product_name TEXT,
      source_file TEXT,
      company_id INT,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_meesho_sales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ${meeshoCols},
      eco_tcs_gstin VARCHAR(40),
      supplier_id VARCHAR(50),
      CONSTRAINT fk_colms_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colms_suborder ON col_meesho_sales (sub_order_num)`);
  await idx(`CREATE INDEX idx_colms_orderdate ON col_meesho_sales (order_date)`);
  await idx(`CREATE INDEX idx_colms_sku ON col_meesho_sales (sku)`);
  await idx(`CREATE INDEX idx_colms_company ON col_meesho_sales (company_id)`);
  await idx(`CREATE INDEX idx_colms_period ON col_meesho_sales (financial_year, month_number)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_meesho_returns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ${meeshoCols},
      CONSTRAINT fk_colmr_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colmr_suborder ON col_meesho_returns (sub_order_num)`);
  await idx(`CREATE INDEX idx_colmr_company ON col_meesho_returns (company_id)`);
  await idx(`CREATE INDEX idx_colmr_period ON col_meesho_returns (financial_year, month_number)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_meesho_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(40),
      order_date DATETIME,
      suborder_no VARCHAR(150),
      product_description TEXT,
      hsn VARCHAR(30),
      invoice_no VARCHAR(100),
      source_file TEXT,
      company_id INT,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_colmi_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colmi_suborder ON col_meesho_invoices (suborder_no)`);
  await idx(`CREATE INDEX idx_colmi_company ON col_meesho_invoices (company_id)`);

  // ---- Bank transactions (import + ledger engine are Phase D, table lives here) ----

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_bank_txns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      bank_name VARCHAR(100),
      account_number VARCHAR(50),
      transaction_date DATE,
      value_date DATE,
      description TEXT,
      ref_number VARCHAR(150),
      debit DECIMAL(14,2) NOT NULL DEFAULT 0,
      credit DECIMAL(14,2) NOT NULL DEFAULT 0,
      balance DECIMAL(14,2),
      transaction_type VARCHAR(30),
      data_month INT,
      data_year INT,
      source_file TEXT,
      company_id INT,
      ledger_head_id INT,
      ledger_manual TINYINT(1) NOT NULL DEFAULT 0,
      platform VARCHAR(30),
      platform_manual TINYINT(1) NOT NULL DEFAULT 0,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_colbank_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
      CONSTRAINT fk_colbank_ledger FOREIGN KEY (ledger_head_id) REFERENCES col_ledgers(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colbank_date ON col_bank_txns (transaction_date)`);
  await idx(`CREATE INDEX idx_colbank_company ON col_bank_txns (company_id)`);
  await idx(`CREATE INDEX idx_colbank_ledger ON col_bank_txns (ledger_head_id)`);
  await idx(`CREATE INDEX idx_colbank_platform ON col_bank_txns (platform)`);

  // ---- Fee invoices (Drogon's purchase_invoices — imported Amazon fee/ad bills) ----

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_fee_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_number VARCHAR(100),
      invoice_date DATE,
      vendor VARCHAR(200),
      vendor_gstin VARCHAR(40),
      bill_to_name VARCHAR(200),
      bill_to_gstin VARCHAR(40),
      place_of_supply VARCHAR(100),
      description TEXT,
      category_code VARCHAR(30),
      taxable_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      igst_rate DECIMAL(14,2) NOT NULL DEFAULT 0,
      igst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      cgst_rate DECIMAL(14,2) NOT NULL DEFAULT 0,
      cgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      sgst_rate DECIMAL(14,2) NOT NULL DEFAULT 0,
      sgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      total_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      invoice_type VARCHAR(50),
      data_month INT,
      data_year INT,
      source_file TEXT,
      company_id INT,
      imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_paid TINYINT(1) NOT NULL DEFAULT 0,
      paid_date DATE,
      CONSTRAINT fk_colfee_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colfee_invnum ON col_fee_invoices (invoice_number)`);
  await idx(`CREATE INDEX idx_colfee_invdate ON col_fee_invoices (invoice_date)`);
  await idx(`CREATE INDEX idx_colfee_company ON col_fee_invoices (company_id)`);

  // ---- SKU cost / tag rules ----

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_sku_costs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sku VARCHAR(100) NOT NULL UNIQUE,
      display_name VARCHAR(200),
      cost_price DECIMAL(14,2) NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS col_sku_tag_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tag_name VARCHAR(100) NOT NULL,
      keyword VARCHAR(100) NOT NULL,
      default_cost DECIMAL(14,2),
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await idx(`CREATE INDEX idx_colskutag_name ON col_sku_tag_rules (tag_name)`);

  // ---- Seed the 34 Tally default ledger groups (insert-if-name-absent) ----
  const existing = await pool.query("SELECT name FROM col_ledger_groups");
  const have = new Set<string>((existing[0] as { name: string }[]).map((r) => r.name));
  for (const [name, nature] of DEFAULT_LEDGER_GROUPS) {
    if (!have.has(name)) {
      await pool.query(
        "INSERT INTO col_ledger_groups (name, nature, is_default) VALUES (?, ?, 1)",
        [name, nature]
      );
    }
  }
}
