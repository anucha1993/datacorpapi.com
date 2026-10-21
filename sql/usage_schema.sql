-- ฐานข้อมูลเก็บการใช้งานโปรแกรม e-WorkPermit Tools (1 แถว = 1 งานที่กดรัน)
-- ใช้กับ database ชื่ออะไรก็ได้ (เลือก database ตอนรัน):
--   mysql -h HOST -u USER -p DATABASE < sql/usage_schema.sql
-- หรือวางทั้งไฟล์ใน phpMyAdmin → แท็บ SQL ของ database นั้น
-- (ถ้าโฮสต์เองและอยากสร้าง database/user ด้วย SQL ดู sql/grants_optional.sql)

CREATE TABLE IF NOT EXISTS usage_runs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id       CHAR(36)     NOT NULL,                 -- UUID ของงาน (กันส่งซ้ำ)
  install_id     CHAR(36)     NOT NULL,                 -- UUID ประจำเครื่องที่ติดตั้ง
  machine        VARCHAR(64)  NOT NULL DEFAULT '',      -- ชื่อเครื่อง Windows
  windows_user   VARCHAR(64)  NOT NULL DEFAULT '',      -- ชื่อ login Windows
  operator       VARCHAR(100) NOT NULL DEFAULT '',      -- ชื่อผู้ใช้งานที่ตั้งในโปรแกรม (ใช้คิดเงิน)
  app_version    VARCHAR(20)  NOT NULL DEFAULT '',
  mode           VARCHAR(40)  NOT NULL,                 -- etracking / receipts / bt30 ...
  mode_group     VARCHAR(20)  NOT NULL DEFAULT '',      -- report / download / submit / booking
  ewp_username   VARCHAR(190) NOT NULL DEFAULT '',      -- บัญชี e-WorkPermit หลักที่ใช้
  accounts       JSON         NULL,                     -- ทุกบัญชี e-WorkPermit ที่ถูกใช้ในงานนี้
  login_file     VARCHAR(255) NOT NULL DEFAULT '',
  started_at     DATETIME     NOT NULL,                 -- เวลาเครื่องผู้ใช้ (Asia/Bangkok)
  finished_at    DATETIME     NOT NULL,
  duration_sec   INT UNSIGNED NOT NULL DEFAULT 0,
  status         ENUM('ok','cancelled','error') NOT NULL,
  record_count   INT UNSIGNED NOT NULL DEFAULT 0,       -- จำนวนรายการที่ได้ (ค่าที่โปรแกรมคืนตอนจบ)
  progress_done  INT UNSIGNED NOT NULL DEFAULT 0,       -- ความคืบหน้าล่าสุด (ใช้กรณียกเลิก/error)
  progress_total INT UNSIGNED NOT NULL DEFAULT 0,
  out_file       VARCHAR(255) NOT NULL DEFAULT '',
  error_msg      TEXT         NULL,
  received_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- เวลาที่เซิร์ฟเวอร์รับ
  UNIQUE KEY uq_event (event_id),
  KEY ix_operator_time (operator, started_at),
  KEY ix_mode_time (mode, started_at),
  KEY ix_install (install_id),
  KEY ix_started (started_at)
) ENGINE=InnoDB;

-- ตารางราคาต่อหน่วย แก้ได้จากเว็บแอป (หน่วย = รายการ)
CREATE TABLE IF NOT EXISTS usage_prices (
  mode        VARCHAR(40)   NOT NULL PRIMARY KEY,
  mode_label  VARCHAR(120)  NOT NULL DEFAULT '',
  price_per_record DECIMAL(10,2) NOT NULL DEFAULT 0,   -- บาท/รายการ
  price_per_run    DECIMAL(10,2) NOT NULL DEFAULT 0,   -- บาท/ครั้งที่รัน (ถ้าต้องการ)
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT IGNORE INTO usage_prices (mode, mode_label, price_per_record, price_per_run) VALUES
  ('etracking', 'e-Tracking — application list',              1.00, 0),
  ('permit_report', 'Permit application report',                  1.00, 0),
  ('aliens', 'Foreign worker list (account)',           0.50, 0),
  ('namelist_alien', 'Renewal name list (NameList)',        0.50, 0),
  ('ticket', 'Ticket ID check',                        0.50, 0),
  ('receipts', 'Receipts / BT.44 / BT.22 forms',              2.00, 0),
  ('results', 'Result notice / application receipt',                     2.00, 0),
  ('bill_payment', 'Payment slips',                           2.00, 0),
  ('payment_receipts', 'Full receipt set',                     2.00, 0),
  ('bt30_ctn', 'Acknowledgement / appointment slips',                     2.00, 0),
  ('appointment', 'Card appointment (address from receipt)',       2.00, 0),
  ('register', 'Worker registration',                       10.00, 0),
  ('inform', 'Employer notification (BT.52)',                   10.00, 0),
  ('bt30', 'MoU permit renewal (BT.30)',                  10.00, 0),
  ('bt44', 'Employer change (BT.44)',                10.00, 0),
  ('booking_availability', 'Appointment slot checker (real-time)',               0.00, 5.00);

-- ราคาเฉพาะลูกค้า (ไม่ระบุ = ใช้ราคาเริ่มต้นใน usage_prices)
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

-- สรุปรายเดือนต่อคน (รวมทุกโหมด)
CREATE OR REPLACE VIEW v_usage_monthly_by_operator AS
SELECT ym, operator,
       SUM(runs) AS runs, SUM(billable_records) AS billable_records,
       SUM(total_sec) AS total_sec, SUM(amount_thb) AS amount_thb
FROM v_usage_monthly
GROUP BY ym, operator;

-- เครื่อง/ผู้ใช้ที่เคยส่งข้อมูล และครั้งล่าสุด
CREATE OR REPLACE VIEW v_usage_installs AS
SELECT install_id, machine, windows_user,
       MIN(started_at) AS first_seen, MAX(finished_at) AS last_seen,
       COUNT(*) AS runs,
       GROUP_CONCAT(DISTINCT operator ORDER BY operator SEPARATOR ', ') AS operators
FROM usage_runs
GROUP BY install_id, machine, windows_user;
