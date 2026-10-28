-- API / license-key platform: products, plans, subscriptions, keys, monthly usage counters.
-- Run once in the same database (after portal_schema, license_schema, invoice_schema, invoice_manual, polar_schema, service_catalog, services_receipts):
--   mysql -h HOST -u USER -p DATABASE < sql/platform_schema.sql

-- What you sell. kind=api → customers create API keys; kind=license → customers get license keys bound to devices.
CREATE TABLE IF NOT EXISTS products (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug                VARCHAR(60)  NOT NULL,                 -- stable id used by your services/apps (e.g. "ocr-api")
  name                VARCHAR(190) NOT NULL,
  tagline             VARCHAR(255) NOT NULL DEFAULT '',
  description         TEXT         NULL,
  kind                ENUM('api','license') NOT NULL DEFAULT 'api',
  unit_label          VARCHAR(40)  NOT NULL DEFAULT 'requests', -- what is metered: requests, tokens, pages, credits…
  docs_url            VARCHAR(500) NOT NULL DEFAULT '',
  service_secret_hash CHAR(64)     NOT NULL DEFAULT '',      -- sha256 of the secret your backend uses for /api/v1/authorize
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order          INT          NOT NULL DEFAULT 0,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_slug (slug)
) ENGINE=InnoDB;

-- Price points of a product (Free / Pro / Business …).
--   billing=month|year → recurring Polar subscription at price_thb (0 = free plan, activates without payment)
--   billing=usage      → pay-as-you-go, no recurring fee; usage beyond included_units invoiced monthly at unit_price_thb
-- Quota is per calendar month for every plan (resets on the 1st, like Copilot).
CREATE TABLE IF NOT EXISTS product_plans (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id         BIGINT UNSIGNED NOT NULL,
  name               VARCHAR(120)  NOT NULL,
  billing            ENUM('month','year','usage') NOT NULL DEFAULT 'month',
  price_thb          DECIMAL(12,2) NOT NULL DEFAULT 0,
  included_units     BIGINT UNSIGNED NULL,                  -- per month; NULL = unlimited, 0 = none included
  unit_price_thb     DECIMAL(12,4) NOT NULL DEFAULT 0,       -- per unit over the quota; 0 = hard stop at the quota
  max_keys           INT UNSIGNED  NOT NULL DEFAULT 5,       -- API keys (api) or license keys (license) per subscription
  max_devices        INT UNSIGNED  NOT NULL DEFAULT 1,       -- license: devices per key, 0 = unlimited
  rate_limit_per_min INT UNSIGNED  NOT NULL DEFAULT 0,       -- api: requests per key per minute, 0 = no limit
  features           TEXT          NULL,                     -- one bullet per line, shown on plan cards
  polar_product_id   VARCHAR(64)   NOT NULL DEFAULT '',      -- recurring product in Polar (same price/interval)
  is_featured        TINYINT(1)    NOT NULL DEFAULT 0,
  is_active          TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order         INT           NOT NULL DEFAULT 0,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_product (product_id, is_active, sort_order)
) ENGINE=InnoDB;

-- A customer's plan. Access is granted while status='active' and period_end is NULL or in the future.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  operator             VARCHAR(100) NOT NULL,                -- portal_users.operator
  product_id           BIGINT UNSIGNED NOT NULL,
  plan_id              BIGINT UNSIGNED NOT NULL,
  status               ENUM('pending','active','past_due','cancelled','expired') NOT NULL DEFAULT 'pending',
  period_start         DATETIME NULL,
  period_end           DATETIME NULL,                        -- NULL = open-ended (usage / free / manual without end)
  cancel_at_period_end TINYINT(1)   NOT NULL DEFAULT 0,
  source               ENUM('polar','manual','free') NOT NULL DEFAULT 'polar',
  provider_sub_id      VARCHAR(64)  NOT NULL DEFAULT '',     -- Polar subscription id
  note                 VARCHAR(255) NOT NULL DEFAULT '',
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_operator (operator, status),
  KEY ix_provider (provider_sub_id),
  KEY ix_plan (plan_id)
) ENGINE=InnoDB;

-- API keys (stored as sha256 only — shown once) and license keys (key_plain kept so the customer can copy it again).
CREATE TABLE IF NOT EXISTS access_keys (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  operator        VARCHAR(100) NOT NULL,
  subscription_id BIGINT UNSIGNED NOT NULL,
  kind            ENUM('api','license') NOT NULL,
  name            VARCHAR(100) NOT NULL DEFAULT '',
  key_prefix      VARCHAR(20)  NOT NULL,                     -- first characters, for display ("dca_sk_Ab3x…")
  key_hash        CHAR(64)     NOT NULL,
  key_plain       VARCHAR(40)  NULL,                         -- license keys only
  last_used_at    DATETIME NULL,
  revoked_at      DATETIME NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_hash (key_hash),
  KEY ix_sub (subscription_id, revoked_at),
  KEY ix_operator (operator)
) ENGINE=InnoDB;

-- Machines activated with a license key (device limit per plan).
CREATE TABLE IF NOT EXISTS key_devices (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  key_id      BIGINT UNSIGNED NOT NULL,
  device_id   VARCHAR(100) NOT NULL,
  device_name VARCHAR(100) NOT NULL DEFAULT '',
  app_version VARCHAR(30)  NOT NULL DEFAULT '',
  ip          VARCHAR(64)  NOT NULL DEFAULT '',
  first_seen  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_key_device (key_id, device_id)
) ENGINE=InnoDB;

-- Monthly usage totals per subscription (no per-request logs). Quota + billing read from here.
CREATE TABLE IF NOT EXISTS usage_counters (
  subscription_id BIGINT UNSIGNED NOT NULL,
  ym              CHAR(7)         NOT NULL,                  -- 2026-10
  units           BIGINT UNSIGNED NOT NULL DEFAULT 0,
  requests        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (subscription_id, ym)
) ENGINE=InnoDB;

-- Invoices: link to the subscription they bill; 'subscription' = recurring Polar charge recorded for history.
ALTER TABLE billing_invoices
  ADD COLUMN IF NOT EXISTS subscription_id BIGINT UNSIGNED NULL AFTER service_id;
ALTER TABLE billing_invoices
  MODIFY COLUMN kind ENUM('usage','manual','subscription') NOT NULL DEFAULT 'usage';
ALTER TABLE billing_invoices ADD INDEX IF NOT EXISTS ix_sub_ym (subscription_id, ym, kind);
