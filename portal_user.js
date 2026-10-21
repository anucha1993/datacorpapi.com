#!/usr/bin/env node
/**
 * จัดการบัญชีลูกค้า Customer Portal จาก command line
 *   node portal_user.js add <ชื่อผู้ใช้งาน> <รหัสผ่าน> [อีเมล] [ชื่อแสดง]   → สร้าง/รีเซ็ตรหัส
 *   node portal_user.js list
 *   node portal_user.js disable <ชื่อผู้ใช้งาน>  |  enable <ชื่อผู้ใช้งาน>
 */
"use strict";
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mysql = require("mysql2/promise");
const portal = require("./lib/portal");

(async () => {
  const [cmd, operator, password, email = "", display = ""] = process.argv.slice(2);
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || "ewp_usage", user: process.env.DB_USER || "ewp_web",
    password: process.env.DB_PASSWORD || "", charset: "utf8mb4", dateStrings: true,
  });
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];
  try {
    if (cmd === "add") {
      const op = await portal.createUser(q, { operator, password, email, display_name: display });
      console.log(`✓ บัญชี portal '${op}' พร้อมใช้ — login ที่ ${process.env.SITE_URL || ""}/portal/login`);
    } else if (cmd === "list") {
      const rows = await q("SELECT operator, display_name, email, is_active, last_login_at, created_at FROM portal_users ORDER BY operator");
      for (const r of rows) console.log(`${r.is_active ? "✓" : "✗"} ${r.operator}  ${r.display_name}  ${r.email}  last login: ${r.last_login_at || "-"}`);
      if (!rows.length) console.log("(ยังไม่มีบัญชี)");
    } else if (cmd === "disable" || cmd === "enable") {
      const r = await q("UPDATE portal_users SET is_active = ? WHERE operator = ?", [cmd === "enable" ? 1 : 0, operator]);
      console.log(r.affectedRows ? `✓ ${cmd} '${operator}'` : `✗ ไม่พบ '${operator}'`);
    } else {
      console.log("ใช้: node portal_user.js add <operator> <password> [email] [display] | list | disable <operator> | enable <operator>");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error("✗", e.message); process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
