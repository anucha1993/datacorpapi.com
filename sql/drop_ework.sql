-- Remove the old e-WorkPermit (Ework) desktop-app usage tracking. IRREVERSIBLE — take a backup first:
--   mysqldump -h HOST -u USER -p DATABASE usage_runs usage_prices usage_prices_customer billing_usage_reports > ework_backup.sql
-- Then:
--   mysql -h HOST -u USER -p DATABASE < sql/drop_ework.sql
--
-- Kept on purpose: portal_users (incl. serial_no), license_devices (SN verification still used by apps),
-- billing_invoices / billing_orders / billing_events, service_catalog, contact_messages.
-- Old monthly usage invoices stay in billing_invoices as history (kind='usage', subscription_id NULL).

DROP VIEW  IF EXISTS v_usage_installs;
DROP VIEW  IF EXISTS v_usage_monthly_by_operator;
DROP VIEW  IF EXISTS v_usage_monthly;
DROP TABLE IF EXISTS usage_prices_customer;
DROP TABLE IF EXISTS usage_prices;
DROP TABLE IF EXISTS usage_runs;
DROP TABLE IF EXISTS billing_usage_reports;   -- Lemon Squeezy usage reports built from usage_runs
