-- บัญชี login ของลูกค้าสำหรับ Customer Portal (/portal) — 1 บัญชีต่อ 1 ชื่อผู้ใช้งาน (operator)
-- รันใน database เดียวกับ usage_schema.sql:
--   mysql -h HOST -u USER -p DATABASE < sql/portal_schema.sql

CREATE TABLE IF NOT EXISTS portal_users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  operator      VARCHAR(100) NOT NULL,                 -- = usage_runs.operator / billing_customers.operator
  password_hash VARCHAR(255) NOT NULL,                 -- scrypt$N$salt$hash
  display_name  VARCHAR(190) NOT NULL DEFAULT '',
  email         VARCHAR(190) NOT NULL DEFAULT '',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  must_change   TINYINT(1) NOT NULL DEFAULT 0,         -- 1 = ให้เปลี่ยนรหัสผ่านครั้งแรกที่ login
  last_login_at DATETIME NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_operator (operator)
) ENGINE=InnoDB;
