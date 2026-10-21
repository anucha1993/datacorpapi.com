-- ระบบใบแจ้งหนี้รายเดือน (จ่ายตามยอดจริงผ่าน Lemon Squeezy แบบ Single payment)
-- รันใน database เดียวกัน (หลัง usage_schema / billing_schema / portal_schema):
--   mysql -h HOST -u USER -p DATABASE < sql/invoice_schema.sql

-- ข้อมูลสำหรับออกใบเสร็จของลูกค้า (เติมให้หน้าชำระเงินของ Lemon Squeezy อัตโนมัติ)
ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS company_name  VARCHAR(190) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tax_id        VARCHAR(32)  NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address       VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zip           VARCHAR(16)  NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country       CHAR(2)      NOT NULL DEFAULT 'TH',
  ADD COLUMN IF NOT EXISTS billing_email VARCHAR(190) NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS billing_invoices (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  invoice_no      VARCHAR(32)  NOT NULL,                 -- INV-202610-0001
  operator        VARCHAR(100) NOT NULL,
  ym              CHAR(7)      NOT NULL,                 -- เดือนที่ใช้งาน
  records         INT UNSIGNED NOT NULL DEFAULT 0,       -- รายการที่คิดเงินในเดือนนั้น
  usage_thb       DECIMAL(12,2) NOT NULL DEFAULT 0,      -- ค่าใช้งานตามราคาต่อรายการ
  carried_thb     DECIMAL(12,2) NOT NULL DEFAULT 0,      -- ยอดยกมาจากเดือนก่อนที่ต่ำกว่าขั้นต่ำ
  adjust_thb      DECIMAL(12,2) NOT NULL DEFAULT 0,      -- ปรับยอดโดยแอดมิน (+/-)
  amount_thb      DECIMAL(12,2) NOT NULL DEFAULT 0,      -- ยอดที่เรียกเก็บ = usage + carried + adjust
  note            VARCHAR(500) NOT NULL DEFAULT '',
  status          ENUM('open','paid','void','carried') NOT NULL DEFAULT 'open',
                  -- open = รอชำระ, paid = ชำระแล้ว, void = ยกเลิก, carried = ต่ำกว่าขั้นต่ำ ยกไปเดือนถัดไป
  checkout_id     VARCHAR(64)  NOT NULL DEFAULT '',       -- Lemon Squeezy checkout UUID
  checkout_url    VARCHAR(700) NOT NULL DEFAULT '',
  checkout_test   TINYINT(1)   NOT NULL DEFAULT 0,
  ls_order_id     BIGINT UNSIGNED NULL,                   -- billing_orders.order_id เมื่อชำระแล้ว
  paid_at         DATETIME NULL,
  paid_via        VARCHAR(30)  NOT NULL DEFAULT '',       -- lemonsqueezy / manual
  due_at          DATE NULL,
  issued_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invoice_no (invoice_no),
  UNIQUE KEY uq_operator_ym (operator, ym),
  KEY ix_status (status, due_at),
  KEY ix_operator (operator, ym)
) ENGINE=InnoDB;
