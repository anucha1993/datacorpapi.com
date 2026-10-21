-- (ทางเลือก) สร้าง database + user ด้วย SQL — ใช้เมื่อโฮสต์ MySQL เอง (VPS/Docker)
-- ถ้าใช้ shared hosting (cPanel/DirectAdmin) ให้สร้าง database และ user ผ่านหน้าควบคุมของโฮสต์แทน
-- แล้วแก้ชื่อ database/user ด้านล่างให้ตรง (เช่น thaidata_ewp)
--
-- แนะนำ 2 user:
--   ewp_app  → ใส่ใน .env ของโปรแกรมทุกเครื่อง: INSERT เฉพาะ usage_runs (ผู้ใช้แก้/ลบ/อ่านไม่ได้)
--   ewp_web  → ให้เว็บแอปใช้: อ่านทุกตาราง + แก้ราคา + ตาราง billing_*/contact_messages

CREATE DATABASE IF NOT EXISTS ewp_usage CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'ewp_app'@'%' IDENTIFIED BY 'CHANGE_ME_app_password';
GRANT INSERT ON ewp_usage.usage_runs TO 'ewp_app'@'%';

CREATE USER IF NOT EXISTS 'ewp_web'@'%' IDENTIFIED BY 'CHANGE_ME_web_password';
GRANT SELECT ON ewp_usage.* TO 'ewp_web'@'%';
GRANT INSERT, UPDATE, DELETE ON ewp_usage.usage_prices TO 'ewp_web'@'%';
GRANT SELECT, INSERT, UPDATE ON ewp_usage.billing_customers     TO 'ewp_web'@'%';
GRANT SELECT, INSERT, UPDATE ON ewp_usage.billing_subscriptions TO 'ewp_web'@'%';
GRANT SELECT, INSERT, UPDATE ON ewp_usage.billing_orders        TO 'ewp_web'@'%';
GRANT SELECT, INSERT         ON ewp_usage.billing_events        TO 'ewp_web'@'%';
GRANT SELECT, INSERT         ON ewp_usage.billing_usage_reports TO 'ewp_web'@'%';
GRANT SELECT, INSERT, UPDATE ON ewp_usage.contact_messages      TO 'ewp_web'@'%';
FLUSH PRIVILEGES;
