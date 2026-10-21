-- ตารางสำหรับการรับชำระเงินผ่าน Lemon Squeezy + ข้อความติดต่อจากหน้าเว็บ
-- รันหลัง usage_schema.sql ใน database เดียวกัน:
--   mysql -h HOST -u USER -p DATABASE < sql/billing_schema.sql

-- ลูกค้า (1 แถวต่อ customer ของ Lemon Squeezy) — operator = ชื่อผู้ใช้งานในโปรแกรมที่ผูกกับลูกค้านี้
CREATE TABLE IF NOT EXISTS billing_customers (
  customer_id   BIGINT UNSIGNED NOT NULL PRIMARY KEY,      -- data.attributes.customer_id
  email         VARCHAR(190) NOT NULL DEFAULT '',
  name          VARCHAR(190) NOT NULL DEFAULT '',
  company       VARCHAR(190) NOT NULL DEFAULT '',          -- จาก checkout[custom][company]
  operator      VARCHAR(100) NOT NULL DEFAULT '',          -- ผูกกับ usage_runs.operator (แก้ได้จาก admin)
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_operator (operator), KEY ix_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  subscription_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY, -- data.id
  customer_id          BIGINT UNSIGNED NOT NULL,
  order_id             BIGINT UNSIGNED NULL,
  product_id           BIGINT UNSIGNED NULL,
  variant_id           BIGINT UNSIGNED NULL,
  product_name         VARCHAR(190) NOT NULL DEFAULT '',
  variant_name         VARCHAR(190) NOT NULL DEFAULT '',
  status               VARCHAR(30)  NOT NULL DEFAULT '',     -- on_trial / active / paused / past_due / unpaid / cancelled / expired
  status_formatted     VARCHAR(40)  NOT NULL DEFAULT '',
  subscription_item_id BIGINT UNSIGNED NULL,                 -- first_subscription_item.id (ใช้ส่ง usage record)
  is_usage_based       TINYINT(1) NOT NULL DEFAULT 0,
  renews_at            DATETIME NULL,
  ends_at              DATETIME NULL,
  trial_ends_at        DATETIME NULL,
  customer_portal_url  VARCHAR(500) NOT NULL DEFAULT '',
  update_payment_url   VARCHAR(500) NOT NULL DEFAULT '',
  user_email           VARCHAR(190) NOT NULL DEFAULT '',
  user_name            VARCHAR(190) NOT NULL DEFAULT '',
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_customer (customer_id), KEY ix_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS billing_orders (
  order_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,      -- data.id
  customer_id    BIGINT UNSIGNED NOT NULL,
  identifier     VARCHAR(64)  NOT NULL DEFAULT '',          -- order UUID ของ LS
  order_number   BIGINT UNSIGNED NULL,
  product_name   VARCHAR(190) NOT NULL DEFAULT '',
  variant_name   VARCHAR(190) NOT NULL DEFAULT '',
  status         VARCHAR(30)  NOT NULL DEFAULT '',          -- pending / paid / refunded / partial_refund
  currency       CHAR(3)      NOT NULL DEFAULT '',
  total          DECIMAL(12,2) NOT NULL DEFAULT 0,          -- หน่วยเงินจริง (LS ส่งเป็นหน่วยย่อย ÷100)
  refunded_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  receipt_url    VARCHAR(500) NOT NULL DEFAULT '',
  user_email     VARCHAR(190) NOT NULL DEFAULT '',
  user_name      VARCHAR(190) NOT NULL DEFAULT '',
  ordered_at     DATETIME NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_customer (customer_id), KEY ix_ordered (ordered_at)
) ENGINE=InnoDB;

-- webhook ทุกครั้งที่รับ (ไว้ตรวจย้อนหลัง + กันประมวลผลซ้ำ)
CREATE TABLE IF NOT EXISTS billing_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  body_hash     CHAR(64) NOT NULL,                          -- sha256 ของ raw body
  event_name    VARCHAR(60) NOT NULL,
  object_type   VARCHAR(30) NOT NULL DEFAULT '',
  object_id     VARCHAR(40) NOT NULL DEFAULT '',
  payload       JSON NOT NULL,
  received_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_hash (body_hash), KEY ix_event (event_name, received_at)
) ENGINE=InnoDB;

-- ยอดการใช้งานที่ส่งไป Lemon Squeezy แล้ว (ต่อ subscription ต่อเดือน)
CREATE TABLE IF NOT EXISTS billing_usage_reports (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subscription_id BIGINT UNSIGNED NOT NULL,
  ym              CHAR(7) NOT NULL,
  operator        VARCHAR(100) NOT NULL DEFAULT '',
  quantity        INT UNSIGNED NOT NULL DEFAULT 0,
  amount_thb      DECIMAL(12,2) NOT NULL DEFAULT 0,          -- ยอดเงินตามราคาของเรา (ไว้เทียบกับ LS)
  action          VARCHAR(10) NOT NULL DEFAULT 'set',
  ok              TINYINT(1) NOT NULL DEFAULT 0,
  response        TEXT NULL,
  sent_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sub_ym (subscription_id, ym)
) ENGINE=InnoDB;

-- ข้อความจากฟอร์มติดต่อบนหน้าเว็บ
CREATE TABLE IF NOT EXISTS contact_messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(190) NOT NULL DEFAULT '',
  email       VARCHAR(190) NOT NULL DEFAULT '',
  company     VARCHAR(190) NOT NULL DEFAULT '',
  message     TEXT NOT NULL,
  ip          VARCHAR(64)  NOT NULL DEFAULT '',
  is_read     TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
