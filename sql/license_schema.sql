-- Serial numbers (licenses) per customer account + devices that verified them.
-- Run once in the same database:  mysql -h HOST -u USER -p DATABASE < sql/license_schema.sql
ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS serial_no        VARCHAR(24) NULL AFTER operator,   -- DCA-XXXX-XXXX-XXXX (shown in portal, entered in the desktop app)
  ADD COLUMN IF NOT EXISTS last_verified_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS max_devices      INT UNSIGNED NOT NULL DEFAULT 0;   -- 0 = unlimited
ALTER TABLE portal_users ADD UNIQUE INDEX IF NOT EXISTS uq_serial (serial_no);

CREATE TABLE IF NOT EXISTS license_devices (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  operator       VARCHAR(100) NOT NULL,
  install_id     CHAR(36)     NOT NULL,                 -- id เครื่องที่โปรแกรมส่งมา
  machine        VARCHAR(64)  NOT NULL DEFAULT '',
  windows_user   VARCHAR(64)  NOT NULL DEFAULT '',
  app_version    VARCHAR(20)  NOT NULL DEFAULT '',
  ip             VARCHAR(64)  NOT NULL DEFAULT '',
  first_seen     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  verify_count   INT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_op_install (operator, install_id),
  KEY ix_operator (operator)
) ENGINE=InnoDB;
