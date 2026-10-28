#!/usr/bin/env node
/**
 * ออกใบแจ้งหนี้ค่าใช้งานเกินโควตา / จ่ายตามใช้งาน ของเดือนที่แล้ว จาก command line (สำหรับ cron)
 *   node invoices.js            → ออก/อัปเดตบิลของ "เดือนที่แล้ว" (รันทุกวันที่ 1 เวลา 06:00)
 *   node invoices.js 2026-10    → เดือนที่ระบุ
 * cron (Plesk Scheduled Task):  0 6 1 * *  /opt/plesk/node/22/bin/node /path/invoices.js >> invoices.log 2>&1
 */
"use strict";
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mysql = require("mysql2/promise");
const invoices = require("./lib/invoices");

const argYm = process.argv[2];
const ym = /^\d{4}-\d{2}$/.test(argYm || "") ? argYm : invoices.prevMonth(new Date().toISOString().slice(0, 7));

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || "ewp_usage", user: process.env.DB_USER || "ewp_web",
    password: process.env.DB_PASSWORD || "", charset: "utf8mb4", timezone: "+07:00", dateStrings: true,
  });
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];
  try {
    const results = await invoices.generateInvoices(q, ym, {
      apiReady: require("./lib/payments").info().ready,
      testMode: require("./lib/payments").info().testMode,
      log: console.log,
    });
    const bad = results.filter(r => r.message.startsWith("ERROR")).length;
    console.log(`${new Date().toISOString()} ${ym}: ${results.length} invoices, ${bad} errors`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error("✗", e.message); process.exit(2);
  } finally {
    await pool.end();
  }
})();
