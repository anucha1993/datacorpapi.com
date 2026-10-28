-- Services sold via pasted Polar payment links + receipt attachments on invoices.
-- Run once in the same database (after service_catalog.sql and polar_schema.sql):
--   mysql -h HOST -u USER -p DATABASE < sql/services_receipts.sql

-- Optional Polar checkout link per service (https://buy.polar.sh/polar_cl_...).
-- Empty = the app creates a fixed-price checkout through the Polar API instead.
ALTER TABLE service_catalog
  ADD COLUMN IF NOT EXISTS payment_link VARCHAR(700) NOT NULL DEFAULT '' AFTER price_thb;

-- Which catalog service an invoice was bought from (NULL = usage / hand-made invoice).
ALTER TABLE billing_invoices
  ADD COLUMN IF NOT EXISTS service_id BIGINT UNSIGNED NULL AFTER kind;
ALTER TABLE billing_invoices ADD INDEX IF NOT EXISTS ix_service (operator, service_id, status);

-- Files attached to an invoice by the admin (receipt / tax invoice PDF or image), visible to the customer.
-- Stored in the database so they survive container rebuilds without an extra volume.
CREATE TABLE IF NOT EXISTS billing_attachments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  invoice_id  BIGINT UNSIGNED NOT NULL,
  kind        ENUM('receipt','tax_invoice','other') NOT NULL DEFAULT 'receipt',
  filename    VARCHAR(190) NOT NULL,
  mime        VARCHAR(100) NOT NULL,
  size        INT UNSIGNED NOT NULL,
  data        MEDIUMBLOB   NOT NULL,          -- up to 16 MB; the app caps uploads at 5 MB
  uploaded_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_invoice (invoice_id)
) ENGINE=InnoDB;
