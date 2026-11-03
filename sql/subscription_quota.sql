-- Per-customer quota: overrides the plan's included_units for one subscription (NULL = use the plan's).
-- e.g. importer168 on AI API KEY · Business gets 1,000,000 credits / month while the plan stays 400,000 for everyone else.
--   mysql -h HOST -u USER -p DATABASE < sql/subscription_quota.sql
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS included_units_override INT UNSIGNED NULL AFTER plan_id;
