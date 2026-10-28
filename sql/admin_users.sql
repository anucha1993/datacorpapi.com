-- Admin accounts (replaces the single ADMIN_PASSWORD in .env).
-- Run once in the same database:
--   mysql -h HOST -u USER -p DATABASE < sql/admin_users.sql
-- First sign-in: open /login — while this table is empty the page asks for ADMIN_PASSWORD (from .env) once
-- to create the first owner account. After that ADMIN_PASSWORD is no longer accepted and can be removed.

CREATE TABLE IF NOT EXISTS admin_users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(60)  NOT NULL,
  display_name    VARCHAR(120) NOT NULL DEFAULT '',
  email           VARCHAR(190) NOT NULL DEFAULT '',
  role            ENUM('owner','staff') NOT NULL DEFAULT 'staff',   -- owner = can manage admin accounts
  password_hash   VARCHAR(200) NOT NULL,                            -- scrypt$N$salt$hash
  must_change     TINYINT(1)   NOT NULL DEFAULT 0,                  -- force a new password at next sign-in
  totp_secret     VARCHAR(64)  NULL,                                -- base32; NULL = 2FA off
  totp_last_step  BIGINT       NOT NULL DEFAULT 0,                  -- last accepted code window (blocks code reuse)
  session_version INT UNSIGNED NOT NULL DEFAULT 1,                  -- bump = sign out every session of this account
  failed_logins   INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until    DATETIME     NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at   DATETIME     NULL,
  last_login_ip   VARCHAR(64)  NOT NULL DEFAULT '',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_username (username)
) ENGINE=InnoDB;
