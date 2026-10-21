#!/usr/bin/env node
/**
 * ส่งยอดการใช้งานรายเดือนไป Lemon Squeezy จาก command line (สำหรับ cron)
 *   node report_usage.js            → เดือนปัจจุบัน
 *   node report_usage.js 2026-10    → เดือนที่ระบุ
 * ตัวอย่าง cron (ทุกวัน 23:50 ส่งยอดเดือนปัจจุบันแบบ set — ค่าล่าสุดทับของเดิม):
 *   50 23 * * *  cd /opt/ewp/webapp && node report_usage.js >> usage_report.log 2>&1
 */
"use strict";
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mysql = require("mysql2/promise");
const { reportUsage } = require("./lib/billing");

const ym = /^\d{4}-\d{2}$/.test(process.argv[2] || "") ? process.argv[2] : new Date().toISOString().slice(0, 7);

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || "ewp_usage", user: process.env.DB_USER || "ewp_web",
    password: process.env.DB_PASSWORD || "", charset: "utf8mb4", timezone: "+07:00", dateStrings: true,
  });
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];
  try {
    const results = await reportUsage(q, ym, {
      apiKey: process.env.LS_API_KEY, action: process.env.LS_USAGE_ACTION || "set",
      quantityMode: process.env.LS_USAGE_QUANTITY || "amount", log: console.log,
    });
    const bad = results.filter(r => !r.ok).length;
    console.log(`${new Date().toISOString()} ${ym}: ${results.length} subscriptions, ${bad} failed`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error("✗", e.message);
    process.exit(2);
  } finally {
    await pool.end();
  }
})();
