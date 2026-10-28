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
  for (const k of ["PAYMENT_PROVIDER", "POLAR_ACCESS_TOKEN", "POLAR_WEBHOOK_SECRET", "POLAR_PRODUCT_ID", "POLAR_SERVER", "LS_API_KEY", "LS_WEBHOOK_SECRET"]) console.log((process.env[k] ? "✓ " : "· ") + k + (process.env[k] ? " ตั้งแล้ว" : " ยังไม่ตั้ง (ไม่บังคับตอนนี้)"));

  for (const m of ["express", "ejs", "mysql2/promise", "cookie-session", "dotenv", "multer"]) {
    try { require(m); ok("module " + m); } catch (e) { bad("module " + m + " โหลดไม่ได้ → กด NPM install (" + e.message.split("\n")[0] + ")"); }
  }
  for (const f of ["server.js", "plans.json", "views/site/home.ejs", "views/dashboard.ejs", "lib/platform.js", "public/style.css", "public/site.css", "lib/billing.js"]) {
    fs.existsSync(path.join(__dirname, f)) ? ok("file " + f) : bad("file " + f + " ไม่พบ → Git Pull ยังไม่ครบ?");
  }

  try {
    const mysql = require("mysql2/promise");
    const c = await mysql.createConnection({
      host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectTimeout: 8000,
    });
    ok(`MySQL ต่อได้ (${process.env.DB_USER}@${process.env.DB_HOST}/${process.env.DB_NAME})`);
    const [t] = await c.query("SHOW TABLES");
    const names = t.map(x => Object.values(x)[0]);
    for (const need of ["portal_users", "billing_invoices", "service_catalog", "billing_attachments", "admin_users", "products", "product_plans", "subscriptions", "access_keys", "usage_counters", "contact_messages"]) names.includes(need) ? ok("table " + need) : bad("table " + need + " ไม่พบ → รัน sql/*.sql");
    await c.end();
  } catch (e) { bad("MySQL ต่อไม่ได้: " + (e.code || "") + " " + e.message); }

  // ค่าลับที่เคยหลุดใน .env.example (repo สาธารณะ) ต้องเปลี่ยน
  {
    const h = (v) => require("crypto").createHash("sha256").update(String(v || "").trim()).digest("hex");
    if (h(process.env.SESSION_SECRET) === "0bbb10203aa32ec7d632e1964ff5e2fe24a33f012ac70c9ca98d1c6270c02fd6") bad("SESSION_SECRET เป็นค่าตัวอย่างที่หลุดใน GitHub → สุ่มค่าใหม่ทันที");
    else if ((process.env.SESSION_SECRET || "").trim().length < 32) bad("SESSION_SECRET สั้นเกินไป (ควร 32+ ตัว)");
    else ok("SESSION_SECRET ปลอดภัย");
    if ((process.env.ADMIN_PASSWORD || "") === "Ewp-aoA_ECTM-2026") bad("ADMIN_PASSWORD เป็นค่าตัวอย่างที่หลุดใน GitHub → เปลี่ยนทันที");
  }

  // เซิร์ฟเวอร์ต่อ Polar ได้ไหม + token ใช้ได้ไหม (อ่านอย่างเดียว)
  if ((process.env.POLAR_ACCESS_TOKEN || "").trim()) {
    const base = /^(sandbox|test)$/i.test((process.env.POLAR_SERVER || "").trim()) ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";
    try {
      const r = await fetch(base + "/v1/products/?limit=1", { headers: { Authorization: "Bearer " + process.env.POLAR_ACCESS_TOKEN.trim() }, signal: AbortSignal.timeout(15000) });
      r.ok ? ok("Polar API ต่อได้ (" + base + ")") : bad("Polar API ตอบ " + r.status + (r.status === 401 ? " → token ผิด หรือ POLAR_SERVER ไม่ตรงกับที่สร้าง token" : ""));
    } catch (e) { const c = e.cause || e; bad("ต่อ " + base + " ไม่ได้: " + (c.code || c.name) + " " + c.message + " → เซิร์ฟเวอร์ออกอินเทอร์เน็ต/DNS/SSL ไม่ได้"); }
  }

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
