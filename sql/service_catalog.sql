-- Sellable services catalog (admin lists services for sale, customers self-checkout from the portal).
-- Purchases become normal manual invoices in billing_invoices (same Polar/Lemon Squeezy checkout + receipt flow).
-- Run once in the same database (after invoice_manual.sql):
--   mysql -h HOST -u USER -p DATABASE < sql/service_catalog.sql

CREATE TABLE IF NOT EXISTS service_catalog (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(190)  NOT NULL,              -- shown to customers
  description VARCHAR(1000) NOT NULL DEFAULT '',
  price_thb   DECIMAL(12,2) NOT NULL,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,     -- hidden services stay out of the portal catalog
  sort_order  INT           NOT NULL DEFAULT 0,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_active_sort (is_active, sort_order)
) ENGINE=InnoDB;
