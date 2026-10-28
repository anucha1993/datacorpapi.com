-- (ทางเลือก) สร้าง database + user ด้วย SQL — ใช้เมื่อโฮสต์ MySQL เอง (VPS/Docker)
-- ถ้าใช้ shared hosting (cPanel/DirectAdmin/Plesk) ให้สร้าง database และ user ผ่านหน้าควบคุมของโฮสต์แทน
-- แล้วแก้ชื่อ database/user ด้านล่างให้ตรง (เช่น thaidata_ewp)
--
-- ewp_web → ให้เว็บแอปใช้ (อ่าน/เขียนทุกตารางของแอป) — ใส่ใน .env ของเว็บเท่านั้น

CREATE DATABASE IF NOT EXISTS ewp_usage CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'ewp_web'@'%' IDENTIFIED BY 'CHANGE_ME_web_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON ewp_usage.* TO 'ewp_web'@'%';
FLUSH PRIVILEGES;
