-- Manual invoices (custom amount) alongside monthly usage invoices.
-- Run once in the same database (after invoice_schema.sql):
--   mysql -h HOST -u USER -p DATABASE < sql/invoice_manual.sql
ALTER TABLE billing_invoices DROP INDEX IF EXISTS uq_operator_ym;
ALTER TABLE billing_invoices
  ADD COLUMN IF NOT EXISTS kind  ENUM('usage','manual') NOT NULL DEFAULT 'usage' AFTER ym,   -- usage = monthly usage invoice, manual = custom amount
  ADD COLUMN IF NOT EXISTS title VARCHAR(190) NOT NULL DEFAULT '' AFTER note;                 -- shown to customer (manual invoices)
ALTER TABLE billing_invoices ADD INDEX IF NOT EXISTS ix_operator_ym_kind (operator, ym, kind);
