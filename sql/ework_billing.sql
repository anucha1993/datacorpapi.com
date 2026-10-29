-- E-work (e-WorkPermit Tools) license billing: each job is converted to tokens by mode, a one-time free allowance
-- per customer, then overage is invoiced monthly through the normal plan pipeline (usage_counters → billing_invoices).
-- Run once after platform_schema.sql (usage_runs comes from the old usage_schema.sql):
--   mysql -h HOST -u USER -p DATABASE < sql/ework_billing.sql

-- one-time free allowance per customer (any plan; used by the E-work License plan)
ALTER TABLE product_plans ADD COLUMN IF NOT EXISTS lifetime_free_units BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER included_units;

-- tokens per job, by mode (edit in Admin → E-work)
CREATE TABLE IF NOT EXISTS ework_token_rates (
  mode              VARCHAR(40)   NOT NULL PRIMARY KEY,
  label             VARCHAR(120)  NOT NULL DEFAULT '',
  tokens_per_record DECIMAL(10,2) NOT NULL DEFAULT 0,
  tokens_per_run    DECIMAL(10,2) NOT NULL DEFAULT 0,   -- charged only when the job finished OK
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- start from the old per-record price list (1 token ≈ ฿1 of the old prices)
INSERT IGNORE INTO ework_token_rates (mode, label, tokens_per_record, tokens_per_run)
  SELECT mode, mode_label, price_per_record, price_per_run FROM usage_prices;

-- lifetime token total per customer + optional per-customer free allowance (NULL = the plan's)
CREATE TABLE IF NOT EXISTS ework_accounts (
  operator     VARCHAR(100)    NOT NULL PRIMARY KEY,
  free_tokens  BIGINT UNSIGNED NULL,
  tokens_total BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- charging state of each job (rows are charged once, by the server)
ALTER TABLE usage_runs ADD COLUMN IF NOT EXISTS tokens          INT UNSIGNED    NULL;
ALTER TABLE usage_runs ADD COLUMN IF NOT EXISTS billable_tokens INT UNSIGNED    NOT NULL DEFAULT 0;
ALTER TABLE usage_runs ADD COLUMN IF NOT EXISTS subscription_id BIGINT UNSIGNED NULL;
ALTER TABLE usage_runs ADD COLUMN IF NOT EXISTS charged_at      DATETIME        NULL;
ALTER TABLE usage_runs ADD INDEX IF NOT EXISTS ix_charged (charged_at);

-- product + plan (edit price / overage / free allowance in Admin → Products → AI Web Tools)
INSERT IGNORE INTO products (slug, name, tagline, description, kind, unit_label, sort_order)
  VALUES ('e-work', 'AI Web Tools', 'Automate e-WorkPermit reports, downloads and submissions',
          'Desktop tool for recruitment agencies: e-Tracking reports, receipts and forms, worker registration and booking — activated with your account Serial Number.',
          'license', 'tokens', 90);
INSERT INTO product_plans (product_id, name, billing, price_thb, included_units, lifetime_free_units, unit_price_thb, max_keys, max_devices, features, is_active, sort_order)
  SELECT p.id, 'License', 'month', 0, 0, 50000, 1.0000, 1, 0,
         '50,000 free tokens (one-time)\nThen ฿1 per token, invoiced monthly\nTokens per job depend on the task (see rates)', 0, 10
  FROM products p WHERE p.slug = 'e-work' AND NOT EXISTS (SELECT 1 FROM product_plans x WHERE x.product_id = p.id);
