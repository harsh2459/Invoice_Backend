import mysql, { ResultSetHeader } from "mysql2/promise";
import bcrypt from "bcryptjs";
import { config } from "./config";
import { initCollatorSchema } from "./collator/schema";

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: false,
  dateStrings: true,
});

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function exec(sql: string, params: any[] = []): Promise<ResultSetHeader> {
  const [res] = await pool.query(sql, params);
  return res as ResultSetHeader;
}

/** Run `fn` inside a transaction on a dedicated connection; rollback on throw. */
export async function withTransaction<T>(
  fn: (tx: {
    query: <R = any>(sql: string, params?: any[]) => Promise<R[]>;
    exec: (sql: string, params?: any[]) => Promise<ResultSetHeader>;
  }) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const tx = {
      query: async <R = any>(sql: string, params: any[] = []): Promise<R[]> => {
        const [rows] = await conn.query(sql, params);
        return rows as R[];
      },
      exec: async (sql: string, params: any[] = []): Promise<ResultSetHeader> => {
        const [res] = await conn.query(sql, params);
        return res as ResultSetHeader;
      },
    };
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE,
      username VARCHAR(255) UNIQUE,
      password_hash VARCHAR(255),
      role ENUM('admin','employee') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      platform VARCHAR(255) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      notes TEXT,
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_payments_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      employee_id INT,
      amount DECIMAL(12,2) NOT NULL,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_sales_employee_id FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  // Drop legacy sales.platform column if this DB predates the schema change.
  const salesCols = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'platform'`
  );
  if (salesCols.length > 0) {
    await pool.query("ALTER TABLE sales DROP COLUMN platform");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platforms (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      category VARCHAR(255) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      notes TEXT,
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_expenses_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  // ---- Invoicing module ----

  // Idempotently add a column to a table (for schema evolution on existing DBs).
  const ensureColumn = async (table: string, column: string, ddl: string) => {
    const existing = await query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (existing.length === 0) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };

  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      address TEXT,
      phone VARCHAR(64),
      email VARCHAR(255),
      gstin VARCHAR(32),
      logo MEDIUMTEXT,
      invoice_prefix VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await ensureColumn("companies", "logo", "MEDIUMTEXT");
  await ensureColumn("companies", "invoice_prefix", "VARCHAR(32)");
  // Collator module extends companies with marketplace-facing fields.
  await ensureColumn("companies", "short_code", "VARCHAR(20)");
  await ensureColumn("companies", "active", "TINYINT(1) NOT NULL DEFAULT 1");
  await ensureColumn("companies", "color", "VARCHAR(10) NOT NULL DEFAULT '#1a6fd4'");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      address TEXT,
      phone VARCHAR(64),
      email VARCHAR(255),
      gstin VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_clients (
      company_id INT NOT NULL,
      client_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, client_id),
      CONSTRAINT fk_cc_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      CONSTRAINT fk_cc_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      unit VARCHAR(32),
      default_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
      hsn VARCHAR(16),
      track_stock TINYINT(1) NOT NULL DEFAULT 0,
      stock_qty DECIMAL(12,3) NOT NULL DEFAULT 0,
      reorder_level DECIMAL(12,3) NOT NULL DEFAULT 0,
      opening_stock DECIMAL(12,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await ensureColumn("products", "gst_rate", "DECIMAL(5,2) NOT NULL DEFAULT 0");
  await ensureColumn("products", "hsn", "VARCHAR(16)");
  await ensureColumn("products", "track_stock", "TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("products", "stock_qty", "DECIMAL(12,3) NOT NULL DEFAULT 0");
  await ensureColumn("products", "reorder_level", "DECIMAL(12,3) NOT NULL DEFAULT 0");
  await ensureColumn("products", "opening_stock", "DECIMAL(12,3) NOT NULL DEFAULT 0");
  await ensureColumn("products", "cost_price", "DECIMAL(12,2) NOT NULL DEFAULT 0");

  // Immutable stock ledger. products.stock_qty is the denormalised running total.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      change_qty DECIMAL(12,3) NOT NULL,
      reason ENUM('purchase','sale','adjustment','opening') NOT NULL,
      ref_type ENUM('purchase_invoice','invoice','manual') NOT NULL DEFAULT 'manual',
      ref_id INT,
      note VARCHAR(255),
      balance_after DECIMAL(12,3) NOT NULL DEFAULT 0,
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_sm_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      CONSTRAINT fk_sm_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await pool
    .query(`CREATE INDEX idx_sm_product ON stock_movements (product_id, id)`)
    .catch(() => {});
  await pool
    .query(`CREATE INDEX idx_sm_ref ON stock_movements (ref_type, ref_id)`)
    .catch(() => {});
  // widen enums for returns (no-op if already wide)
  await pool
    .query(
      `ALTER TABLE stock_movements
         MODIFY reason ENUM('purchase','sale','adjustment','opening','sales_return','purchase_return') NOT NULL,
         MODIFY ref_type ENUM('purchase_invoice','invoice','manual','sales_return','purchase_return') NOT NULL DEFAULT 'manual'`
    )
    .catch(() => {});

  // Per-company low-stock WhatsApp alert config (one row per company).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_alert_settings (
      company_id INT PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      alert_phone VARCHAR(32),
      message TEXT,
      send_hour TINYINT NOT NULL DEFAULT 10,
      send_minute TINYINT NOT NULL DEFAULT 0,
      last_run_on DATE NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_sas_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_products (
      company_id INT NOT NULL,
      product_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, product_id),
      CONSTRAINT fk_cp_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      CONSTRAINT fk_cp_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Invoice header. Totals are denormalised, recomputed on every write:
  //   subtotal  = Σ line amount (qty*rate)
  //   discount_value = discount_is_pct ? subtotal*discount/100 : discount
  //   taxable   = subtotal - discount_value
  //   tax_total = Σ line tax (on each line's share after proportional discount)
  //   total     = taxable + tax_total
  //   balance   = total - amount_paid   (payment_status derived from this)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT,
      client_id INT,
      invoice_date DATE NOT NULL,
      due_date DATE,
      number VARCHAR(64),
      notes TEXT,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount_is_pct TINYINT(1) NOT NULL DEFAULT 1,
      discount_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      tax_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
      payment_status ENUM('unpaid','partial','paid') NOT NULL DEFAULT 'unpaid',
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_inv_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
      CONSTRAINT fk_inv_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      CONSTRAINT fk_inv_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await ensureColumn("invoices", "due_date", "DATE");
  await ensureColumn("invoices", "subtotal", "DECIMAL(12,2) NOT NULL DEFAULT 0");
  await ensureColumn("invoices", "discount", "DECIMAL(12,2) NOT NULL DEFAULT 0");
  await ensureColumn("invoices", "discount_is_pct", "TINYINT(1) NOT NULL DEFAULT 1");
  await ensureColumn("invoices", "discount_value", "DECIMAL(12,2) NOT NULL DEFAULT 0");
  await ensureColumn("invoices", "tax_total", "DECIMAL(12,2) NOT NULL DEFAULT 0");
  await ensureColumn("invoices", "amount_paid", "DECIMAL(12,2) NOT NULL DEFAULT 0");
  await ensureColumn(
    "invoices",
    "payment_status",
    "ENUM('unpaid','partial','paid') NOT NULL DEFAULT 'unpaid'"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      product_id INT,
      description VARCHAR(255) NOT NULL,
      hsn VARCHAR(16),
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      CONSTRAINT fk_item_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      CONSTRAINT fk_item_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await ensureColumn("invoice_items", "hsn", "VARCHAR(16)");
  await ensureColumn("invoice_items", "gst_rate", "DECIMAL(5,2) NOT NULL DEFAULT 0");
  await ensureColumn("invoice_items", "tax_amount", "DECIMAL(12,2) NOT NULL DEFAULT 0");

  // Per-company invoice number counters (for PREFIX-YYYY-00001 numbering).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_counters (
      company_id INT NOT NULL,
      year INT NOT NULL,
      seq INT NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, year),
      CONSTRAINT fk_ic_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // ---- Purchases module (supplier bills — mirror of sales invoices) ----

  await pool.query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      address TEXT,
      phone VARCHAR(64),
      email VARCHAR(255),
      gstin VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_suppliers (
      company_id INT NOT NULL,
      supplier_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, supplier_id),
      CONSTRAINT fk_cs_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      CONSTRAINT fk_cs_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Purchase bill header. Same denormalised-totals model as invoices, but
  // `number` is the SUPPLIER'S bill number (free text, not auto-generated).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT,
      supplier_id INT,
      bill_date DATE NOT NULL,
      due_date DATE,
      number VARCHAR(64),
      notes TEXT,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount_is_pct TINYINT(1) NOT NULL DEFAULT 1,
      discount_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      tax_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
      payment_status ENUM('unpaid','partial','paid') NOT NULL DEFAULT 'unpaid',
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_pinv_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
      CONSTRAINT fk_pinv_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
      CONSTRAINT fk_pinv_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_invoice_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      purchase_invoice_id INT NOT NULL,
      product_id INT,
      description VARCHAR(255) NOT NULL,
      hsn VARCHAR(16),
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      CONSTRAINT fk_pitem_bill FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      CONSTRAINT fk_pitem_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  // Bank accounts — one belongs to exactly one company (firm).
  // Created before purchase_payments / invoice_payments because they FK to it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      last4 VARCHAR(4),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_ba_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // Payments YOU made against a supplier bill.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      purchase_invoice_id INT NOT NULL,
      bank_account_id INT,
      paid_on DATE NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_pp_bill FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      CONSTRAINT fk_pp_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL,
      CONSTRAINT fk_pp_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await pool
    .query(`CREATE INDEX idx_pp_bill ON purchase_payments (purchase_invoice_id)`)
    .catch(() => {});

  // Itemised invoice payments. invoices.amount_paid / payment_status are kept in
  // sync from these rows (recomputeInvoicePayment). note: invoices that had a
  // non-zero amount_paid before this table existed simply show no itemised rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      bank_account_id INT,
      paid_on DATE NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_ip_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      CONSTRAINT fk_ip_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL,
      CONSTRAINT fk_ip_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  // Link an invoice_payments row back to the on-account receipt it came from
  // (NULL = a payment recorded directly against one invoice).
  await ensureColumn("invoice_payments", "receipt_id", "INT");
  await ensureColumn(
    "invoice_payments",
    "mode",
    "ENUM('cash','upi','bank','cheque','card','other') NOT NULL DEFAULT 'cash'"
  );
  await ensureColumn("invoice_payments", "reference", "VARCHAR(120)");

  // Single append-only ledger. Every money-moving event (invoice, receipt,
  // return, ...) writes ONE row here. A party's balance is always
  //   SUM(debit) - SUM(credit)   for client  → positive = they owe us
  //                              for supplier → positive = we owe them
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      party_type ENUM('client','supplier') NOT NULL,
      party_id INT NOT NULL,
      company_id INT,
      entry_date DATE NOT NULL,
      source_type ENUM('invoice','receipt','sales_return','purchase','payment','purchase_return','opening','adjustment') NOT NULL,
      source_id INT,
      particulars VARCHAR(255) NOT NULL,
      ref VARCHAR(64),
      debit DECIMAL(14,2) NOT NULL DEFAULT 0,
      credit DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_le_party (party_type, party_id, entry_date, id),
      INDEX idx_le_source (source_type, source_id)
    ) ENGINE=InnoDB
  `);

  // On-account payments from a client, not tied to one bill at entry time. Each
  // receipt is FIFO-applied to the client's oldest unpaid invoices; whatever is
  // left sits in `unapplied` as an advance/credit.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_receipts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_id INT NOT NULL,
      company_id INT,
      number VARCHAR(64),
      receipt_date DATE NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      unapplied DECIMAL(12,2) NOT NULL DEFAULT 0,
      bank_account_id INT,
      notes TEXT,
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_cr_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      CONSTRAINT fk_cr_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
      CONSTRAINT fk_cr_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL,
      CONSTRAINT fk_cr_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await ensureColumn(
    "client_receipts",
    "mode",
    "ENUM('cash','upi','bank','cheque','card','other') NOT NULL DEFAULT 'cash'"
  );
  await ensureColumn("client_receipts", "reference", "VARCHAR(120)");

  // Goods a customer sent back. Reduces their ledger balance (credit note);
  // restocks inventory unless the goods were damaged.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_returns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_id INT NOT NULL,
      company_id INT,
      invoice_id INT,
      number VARCHAR(64),
      return_date DATE NOT NULL,
      reason ENUM('damaged','wrong_item','excess','not_needed','other') NOT NULL DEFAULT 'other',
      restock TINYINT(1) NOT NULL DEFAULT 1,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
      tax_total DECIMAL(12,2) NOT NULL DEFAULT 0,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_sret_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      CONSTRAINT fk_sret_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
      CONSTRAINT fk_sret_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
      CONSTRAINT fk_sret_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_return_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sales_return_id INT NOT NULL,
      product_id INT,
      description VARCHAR(255) NOT NULL,
      hsn VARCHAR(16),
      qty DECIMAL(12,2) NOT NULL DEFAULT 1,
      rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      CONSTRAINT fk_sreti_ret FOREIGN KEY (sales_return_id) REFERENCES sales_returns(id) ON DELETE CASCADE,
      CONSTRAINT fk_sreti_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  // ---- WhatsApp integration ----

  // Single settings row (id = 1) holding the JSON message templates.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_settings (
      id INT PRIMARY KEY,
      templates JSON,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Log of every WhatsApp message sent from an invoice (invoice PDF, reminder, free text).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT,
      invoice_id INT,
      client_id INT,
      phone VARCHAR(32) NOT NULL,
      kind ENUM('invoice','reminder','text') NOT NULL,
      body TEXT,
      status ENUM('sent','failed') NOT NULL,
      error TEXT,
      wam_id VARCHAR(128),
      created_by INT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_wam_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      CONSTRAINT fk_wam_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      CONSTRAINT fk_wam_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);
  await pool.query(
    `CREATE INDEX idx_wam_invoice ON wa_messages (invoice_id)`
  ).catch(() => {/* index already exists */});
  await pool
    .query(`ALTER TABLE wa_messages ADD COLUMN company_id INT NULL`)
    .catch(() => {/* column already exists */});

  // ---- WhatsApp inbox (per-company chat mirror from Baileys) ----

  // One row per company that has ever tried to pair. Drives auto-start on boot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      company_id INT PRIMARY KEY,
      status VARCHAR(24) NOT NULL DEFAULT 'idle',
      phone_number VARCHAR(32),
      display_name VARCHAR(255),
      last_connected_at TIMESTAMP NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_wasess_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_contacts (
      company_id INT NOT NULL,
      jid VARCHAR(128) NOT NULL,
      name VARCHAR(255),
      notify VARCHAR(255),
      is_business TINYINT(1) NOT NULL DEFAULT 0,
      pic_url TEXT,
      pic_fetched_at TIMESTAMP NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, jid)
    ) ENGINE=InnoDB
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_chats (
      company_id INT NOT NULL,
      jid VARCHAR(128) NOT NULL,
      name VARCHAR(255),
      is_group TINYINT(1) NOT NULL DEFAULT 0,
      last_message_text TEXT,
      last_message_ts BIGINT NOT NULL DEFAULT 0,
      unread_count INT NOT NULL DEFAULT 0,
      archived TINYINT(1) NOT NULL DEFAULT 0,
      pinned TINYINT(1) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, jid)
    ) ENGINE=InnoDB
  `);
  await pool
    .query(`CREATE INDEX idx_wa_chats_ts ON wa_chats (company_id, last_message_ts DESC)`)
    .catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_chat_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL,
      msg_key VARCHAR(160) NOT NULL,
      chat_jid VARCHAR(128) NOT NULL,
      from_me TINYINT(1) NOT NULL DEFAULT 0,
      sender_jid VARCHAR(128),
      ts BIGINT NOT NULL DEFAULT 0,
      type VARCHAR(32) NOT NULL DEFAULT 'text',
      text MEDIUMTEXT,
      media_path VARCHAR(255),
      media_mime VARCHAR(128),
      filename VARCHAR(255),
      status TINYINT NOT NULL DEFAULT 0,
      quoted_key VARCHAR(160),
      raw JSON,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wacm_company_key (company_id, msg_key)
    ) ENGINE=InnoDB
  `);
  await pool
    .query(`CREATE INDEX idx_wacm_chat_ts ON wa_chat_messages (company_id, chat_jid, ts DESC)`)
    .catch(() => {});

  // ---- Collator module (marketplace ingestion + ledger) ----
  await initCollatorSchema(pool);

  // ---- one-time backfill of ledger_entries from existing docs ----
  const [le] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM ledger_entries");
  const [invN] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM invoices");
  if ((le?.n ?? 0) === 0 && (invN?.n ?? 0) > 0) {
    // sales invoices → debit
    await exec(`
      INSERT INTO ledger_entries
        (party_type, party_id, company_id, entry_date, source_type, source_id, particulars, ref, debit, credit, created_by)
      SELECT 'client', i.client_id, i.company_id, i.invoice_date, 'invoice', i.id,
             CONCAT('Sales Invoice', IFNULL(CONCAT(' — ', co.name), '')),
             i.number, i.total, 0, i.created_by
        FROM invoices i LEFT JOIN companies co ON co.id = i.company_id
       WHERE i.client_id IS NOT NULL
    `);
    // on-account receipts → credit
    await exec(`
      INSERT INTO ledger_entries
        (party_type, party_id, company_id, entry_date, source_type, source_id, particulars, ref, debit, credit, created_by)
      SELECT 'client', r.client_id, r.company_id, r.receipt_date, 'receipt', r.id,
             CONCAT('Payment Received', IFNULL(CONCAT(' — ', r.notes), '')),
             r.number, 0, r.amount, r.created_by
        FROM client_receipts r
    `);
    // direct "paid now" on an invoice (not linked to a receipt) → credit
    await exec(`
      INSERT INTO ledger_entries
        (party_type, party_id, company_id, entry_date, source_type, source_id, particulars, ref, debit, credit, created_by)
      SELECT 'client', i.client_id, i.company_id, ip.paid_on, 'payment', ip.id,
             CONCAT('Payment against ', IFNULL(i.number, CONCAT('#', i.id))),
             i.number, 0, ip.amount, ip.created_by
        FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
       WHERE ip.receipt_id IS NULL AND i.client_id IS NOT NULL
    `);
    console.log("Backfilled ledger_entries from existing invoices / receipts / payments");
  }

  const rows = await query<{ count: number }>(
    "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"
  );
  if ((rows[0]?.count ?? 0) === 0) {
    const hash = bcrypt.hashSync("admin123", 10);
    await exec(
      "INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      ["Store Admin", "admin@store.com", "admin", hash, "admin"]
    );
    console.log("Seeded default admin user: admin / admin123");
  }

  const platformCount = await query<{ count: number }>("SELECT COUNT(*) AS count FROM platforms");
  if ((platformCount[0]?.count ?? 0) === 0) {
    for (const name of ["Amazon", "Flipkart", "Meesho", "Other"]) {
      await exec("INSERT INTO platforms (name) VALUES (?)", [name]);
    }
  }

  const categoryCount = await query<{ count: number }>("SELECT COUNT(*) AS count FROM categories");
  if ((categoryCount[0]?.count ?? 0) === 0) {
    for (const name of [
      "Packaging",
      "Shipping",
      "Salary",
      "Rent",
      "Utilities",
      "Ads/Marketing",
      "Returns/Refund",
      "Other",
    ]) {
      await exec("INSERT INTO categories (name) VALUES (?)", [name]);
    }
  }
}

export default pool;
