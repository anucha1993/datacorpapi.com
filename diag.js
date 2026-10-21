#!/usr/bin/env node
/**
 * ตรวจสภาพแวดล้อมบนเซิร์ฟเวอร์โดยไม่ต้องใช้ SSH — รันจาก Plesk: Node.js → Run script → diag
 * (หรือ `npm run diag`) พิมพ์ว่าขาดอะไร / ต่อ DB ได้ไหม / โหลดโมดูลได้ไหม
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ok = (m) => console.log("✓ " + m);
const bad = (m) => console.log("✗ " + m);

(async () => {
  console.log("node", process.version, "| cwd", process.cwd(), "| __dirname", __dirname);
  console.log("NODE_ENV", process.env.NODE_ENV || "(unset)", "| PORT", process.env.PORT || "(unset)");

  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) ok(".env พบที่ " + envPath); else bad(".env ไม่พบที่ " + envPath + " → สร้างจาก .env.example");
  require("dotenv").config({ path: envPath });

  for (const k of ["ADMIN_PASSWORD", "SESSION_SECRET", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "SITE_URL", "COMPANY_NAME", "COMPANY_EMAIL"]) {
    const v = process.env[k];
    if (!v) bad(`${k} ว่าง`); else if (/CHANGE_ME/i.test(v)) bad(`${k} ยังเป็น CHANGE_ME`); else ok(`${k} ตั้งแล้ว`);
  }
  for (const k of ["LS_API_KEY", "LS_WEBHOOK_SECRET", "LS_CHECKOUT_URL_PAYG"]) console.log((process.env[k] ? "✓ " : "· ") + k + (process.env[k] ? " ตั้งแล้ว" : " ยังไม่ตั้ง (ไม่บังคับตอนนี้)"));

  for (const m of ["express", "ejs", "mysql2/promise", "cookie-session", "dotenv"]) {
    try { require(m); ok("module " + m); } catch (e) { bad("module " + m + " โหลดไม่ได้ → กด NPM install (" + e.message.split("\n")[0] + ")"); }
  }
  for (const f of ["server.js", "plans.json", "views/site/home.ejs", "views/dashboard.ejs", "public/style.css", "public/site.css", "lib/billing.js"]) {
    fs.existsSync(path.join(__dirname, f)) ? ok("file " + f) : bad("file " + f + " ไม่พบ → Git Pull ยังไม่ครบ?");
  }

  try {
    const mysql = require("mysql2/promise");
    const c = await mysql.createConnection({
      host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectTimeout: 8000,
    });
    const [r] = await c.query("SELECT COUNT(*) n FROM usage_runs");
    ok(`MySQL ต่อได้ (${process.env.DB_USER}@${process.env.DB_HOST}/${process.env.DB_NAME}) usage_runs = ${r[0].n} แถว`);
    const [t] = await c.query("SHOW TABLES");
    const names = t.map(x => Object.values(x)[0]);
    for (const need of ["usage_prices", "billing_subscriptions", "contact_messages"]) names.includes(need) ? ok("table " + need) : bad("table " + need + " ไม่พบ → รัน sql/*.sql");
    await c.end();
  } catch (e) { bad("MySQL ต่อไม่ได้: " + (e.code || "") + " " + e.message); }

  // โหลดแอปจริงแบบไม่เปิดพอร์ต (ตรวจ syntax/require ทั้งไฟล์)
  try {
    const http = require("http");
    const orig = http.Server.prototype.listen;
    http.Server.prototype.listen = function () { console.log("✓ server.js โหลดสำเร็จ (ข้ามการเปิดพอร์ต)"); return this; };
    require("./server.js");
    http.Server.prototype.listen = orig;
  } catch (e) { bad("server.js โหลดไม่ได้: " + e.stack.split("\n").slice(0, 4).join(" | ")); }
  setTimeout(() => process.exit(0), 300);
})();
