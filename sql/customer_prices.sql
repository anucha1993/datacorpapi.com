-- Per-customer price overrides. A customer (operator) can have its own price per mode;
-- modes without an override fall back to the default prices in usage_prices.
-- Run once in the same database:  mysql -h HOST -u USER -p DATABASE < sql/customer_prices.sql

CREATE TABLE IF NOT EXISTS usage_prices_customer (
  operator         VARCHAR(100)  NOT NULL,
  mode             VARCHAR(40)   NOT NULL,
  price_per_record DECIMAL(10,2) NULL,        -- NULL = use default
  price_per_run    DECIMAL(10,2) NULL,        -- NULL = use default
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (operator, mode)
) ENGINE=InnoDB;

-- Monthly summary per operator per mode with the EFFECTIVE unit price (customer override → default)
CREATE OR REPLACE VIEW v_usage_monthly AS
SELECT
  DATE_FORMAT(r.started_at, '%Y-%m')                              AS ym,
  r.operator,
  r.mode,
  COALESCE(p.mode_label, r.mode)                                  AS mode_label,
  r.mode_group,
  COUNT(*)                                                        AS runs,
  SUM(r.status = 'ok')                                            AS runs_ok,
  SUM(r.status = 'cancelled')                                     AS runs_cancelled,
  SUM(r.status = 'error')                                         AS runs_error,
  SUM(CASE WHEN r.status = 'ok' THEN r.record_count
           ELSE GREATEST(r.record_count, r.progress_done) END)    AS billable_records,
  SUM(r.duration_sec)                                             AS total_sec,
  COALESCE(pc.price_per_record, p.price_per_record, 0)            AS unit_price,
  COALESCE(pc.price_per_run, p.price_per_run, 0)                  AS run_price,
  (pc.operator IS NOT NULL AND (pc.price_per_record IS NOT NULL OR pc.price_per_run IS NOT NULL)) AS custom_price,
  ROUND(SUM(CASE WHEN r.status = 'ok' THEN r.record_count
                 ELSE GREATEST(r.record_count, r.progress_done) END)
        * COALESCE(pc.price_per_record, p.price_per_record, 0)
        + COUNT(*) * COALESCE(pc.price_per_run, p.price_per_run, 0), 2) AS amount_thb
FROM usage_runs r
LEFT JOIN usage_prices p ON p.mode = r.mode
LEFT JOIN usage_prices_customer pc ON pc.operator = r.operator AND pc.mode = r.mode
GROUP BY ym, r.operator, r.mode, mode_label, r.mode_group, unit_price, run_price, custom_price;
