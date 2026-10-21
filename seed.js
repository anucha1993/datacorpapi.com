#!/usr/bin/env node
/**
 * ใส่ข้อมูลตัวอย่าง (demo) ลงฐานข้อมูล เพื่อดูหน้าเว็บ/หลังบ้านก่อนมีข้อมูลจริง
 *   node seed.js          → ใส่ข้อมูลตัวอย่าง (รันซ้ำได้ ไม่ซ้ำ)
 *   node seed.js --clean  → ลบข้อมูลตัวอย่างทั้งหมดออก (เฉพาะแถวที่ seed ใส่)
 * ข้อมูลตัวอย่างทุกแถวมีเครื่องหมาย: operator ขึ้นต้น "demo-", install_id ขึ้นต้น "seed-", event_id ขึ้นต้น "seed-"
 */
"use strict";
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const MODES = {
  etracking: "report", permit_report: "report", aliens: "report", namelist_alien: "report", ticket: "report",
  receipts: "download", results: "download", bill_payment: "download", payment_receipts: "download",
  bt30_ctn: "download", appointment: "download", register: "submit", inform: "submit", bt30: "submit",
  bt44: "submit", booking_availability: "booking",
};
const OPERATORS = [
  { operator: "demo-hr-bangkok", machine: "HR-PC01", win: "somchai", email: "hr.bangkok@example.com", name: "สมชาย ใจดี", company: "บริษัท ตัวอย่าง เอ จำกัด" },
  { operator: "demo-hr-chonburi", machine: "HR-PC02", win: "suda", email: "hr.chonburi@example.com", name: "สุดา รักงาน", company: "บริษัท ตัวอย่าง บี จำกัด" },
  { operator: "demo-agency", machine: "AGENT-NB", win: "agent", email: "agency@example.com", name: "Agency Co.", company: "บริษัท นำเข้า ซี จำกัด" },
];
const ACCOUNTS = ["info@example-a.com", "hr@example-b.com", "agent@example-c.com"];

// สุ่มแบบคงที่ (รันซ้ำได้ผลเหมือนเดิม)
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function months(n) {
  const out = [], d = new Date();
  for (let i = 0; i < n; i++) out.push({ y: d.getFullYear(), m: d.getMonth() - i });
  return out.map(({ y, m }) => new Date(y, m, 1));
}

async function main() {
  const clean = process.argv.includes("--clean");
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || "ewp_usage", user: process.env.DB_USER || "ewp_web",
    password: process.env.DB_PASSWORD || "", charset: "utf8mb4", timezone: "+07:00",
  });
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];
  try {
    await q("SELECT 1");
    if (clean) {
      const r1 = await q("DELETE FROM usage_runs WHERE install_id LIKE 'seed-%'");
      const r2 = await q("DELETE FROM billing_usage_reports WHERE operator LIKE 'demo-%'");
      const r3 = await q("DELETE FROM billing_subscriptions WHERE customer_id BETWEEN 900001 AND 900099");
      const r4 = await q("DELETE FROM billing_orders WHERE customer_id BETWEEN 900001 AND 900099");
      const r5 = await q("DELETE FROM billing_customers WHERE customer_id BETWEEN 900001 AND 900099");
      const r6 = await q("DELETE FROM contact_messages WHERE email LIKE '%@example.com' AND name LIKE 'demo %'");
      console.log(`✓ ลบข้อมูลตัวอย่าง: usage_runs ${r1.affectedRows}, reports ${r2.affectedRows}, subscriptions ${r3.affectedRows}, orders ${r4.affectedRows}, customers ${r5.affectedRows}, messages ${r6.affectedRows}`);
      return;
    }

    // ---- usage_runs: 3 เดือนล่าสุด ----
    let inserted = 0, total = 0;
    const modeKeys = Object.keys(MODES);
    for (const mStart of months(3)) {
      const daysInMonth = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0).getDate();
      const today = new Date();
      const lastDay = (mStart.getMonth() === today.getMonth() && mStart.getFullYear() === today.getFullYear()) ? today.getDate() : daysInMonth;
      for (const op of OPERATORS) {
        const runsThisMonth = 18 + Math.floor(rnd() * 14);
        for (let i = 0; i < runsThisMonth; i++) {
          const day = 1 + Math.floor(rnd() * lastDay);
          const start = new Date(mStart.getFullYear(), mStart.getMonth(), day, 8 + Math.floor(rnd() * 9), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
          const mode = pick(modeKeys);
          const group = MODES[mode];
          const total_ = group === "submit" ? 3 + Math.floor(rnd() * 25) : group === "booking" ? 1 : 20 + Math.floor(rnd() * 300);
          const r = rnd();
          const status = r < 0.85 ? "ok" : r < 0.95 ? "cancelled" : "error";
          const done = status === "ok" ? total_ : Math.floor(total_ * rnd());
          const dur = Math.round(total_ * (group === "submit" ? 45 : 6) * (0.7 + rnd() * 0.6)) + 20;
          const end = new Date(start.getTime() + dur * 1000);
          const eventId = "seed-" + crypto.createHash("md5").update(`${op.operator}|${fmt(start)}|${mode}|${i}`).digest("hex").slice(0, 27);
          const accts = mode === "etracking" || group === "download" ? JSON.stringify([pick(ACCOUNTS), pick(ACCOUNTS)].filter((v, k, a) => a.indexOf(v) === k)) : JSON.stringify([ACCOUNTS[OPERATORS.indexOf(op)]]);
          const res = await q(
            `INSERT IGNORE INTO usage_runs (event_id, install_id, machine, windows_user, operator, app_version, mode, mode_group, ewp_username, accounts, login_file,
               started_at, finished_at, duration_sec, status, record_count, progress_done, progress_total, out_file, error_msg)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [eventId, "seed-" + op.machine.toLowerCase(), op.machine, op.win, op.operator, "31", mode, group, JSON.parse(accts)[0], accts,
             group === "report" ? "" : "UsernameLogin.xlsx", fmt(start), fmt(end), dur, status, status === "ok" ? total_ : done, done, total_,
             `reports/WA_${mode}_report_${fmt(start).replace(/[- :]/g, "").slice(0, 15)}.xlsx`, status === "error" ? "TimeoutError: page.goto: Timeout 30000ms exceeded" : null],
          );
          total++; inserted += res.affectedRows;
        }
      }
    }
    console.log(`✓ usage_runs: ใส่ใหม่ ${inserted} / ทั้งหมด ${total} แถว (3 ผู้ใช้งาน × 3 เดือน)`);

    // ---- ลูกค้า / subscription / คำสั่งซื้อ ----
    const now = new Date();
    const renew = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const subs = [
      { cid: 900001, op: OPERATORS[0], sid: 910001, oid: 920001, plan: "Pay as you go", variant: "Default", usage: 1, item: 930001, status: "active" },
      { cid: 900002, op: OPERATORS[1], sid: 910002, oid: 920002, plan: "Pay as you go", variant: "Default", usage: 1, item: 930002, status: "active" },
      { cid: 900003, op: OPERATORS[2], sid: 910003, oid: 920003, plan: "Pay as you go", variant: "Default", usage: 1, item: 930003, status: "cancelled" },
    ];
    for (const s of subs) {
      await q(`INSERT INTO billing_customers (customer_id, email, name, company, operator) VALUES (?,?,?,?,?)
               ON DUPLICATE KEY UPDATE email=VALUES(email), name=VALUES(name), company=VALUES(company), operator=VALUES(operator)`,
        [s.cid, s.op.email, s.op.name, s.op.company, s.op.operator]);
      await q(`INSERT INTO billing_subscriptions (subscription_id, customer_id, order_id, product_id, variant_id, product_name, variant_name, status, status_formatted,
                 subscription_item_id, is_usage_based, renews_at, ends_at, customer_portal_url, user_email, user_name)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON DUPLICATE KEY UPDATE status=VALUES(status), status_formatted=VALUES(status_formatted), renews_at=VALUES(renews_at), ends_at=VALUES(ends_at)`,
        [s.sid, s.cid, s.oid, 1, s.usage ? 1 : 2, s.plan, s.variant, s.status, s.status === "active" ? "Active" : "Cancelled", s.item, s.usage,
         fmt(renew), s.status === "cancelled" ? fmt(renew) : null, "https://app.lemonsqueezy.com/my-orders/demo", s.op.email, s.op.name]);
      await q(`INSERT INTO billing_orders (order_id, customer_id, identifier, order_number, product_name, variant_name, status, currency, total, refunded_total, receipt_url, user_email, user_name, ordered_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON DUPLICATE KEY UPDATE status=VALUES(status), total=VALUES(total)`,
        [s.oid, s.cid, "demo-" + s.oid, s.oid - 919000, s.plan, s.variant, "paid", "THB", s.usage ? 0 : 2900, 0, "https://app.lemonsqueezy.com/my-orders/demo/receipt",
         s.op.email, s.op.name, fmt(new Date(now.getFullYear(), now.getMonth() - 2, 3, 10, 15, 0))]);
    }
    console.log(`✓ billing: ลูกค้า ${subs.length}, subscriptions ${subs.length}, คำสั่งซื้อ ${subs.length}`);

    // ---- ข้อความติดต่อ ----
    const msgs = await q("SELECT COUNT(*) n FROM contact_messages WHERE name LIKE 'demo %'");
    if (!msgs[0].n) {
      await q("INSERT INTO contact_messages (name, email, company, message, ip) VALUES (?,?,?,?,?), (?,?,?,?,?)",
        ["demo คุณวิภา", "wipa@example.com", "บริษัท ตัวอย่าง ดี จำกัด", "สนใจแพ็กเกจ Pay as you go ดูแลคนต่างด้าวประมาณ 300 คน ขอทดลองใช้ก่อนได้ไหมคะ", "127.0.0.1",
         "demo Mr. Ken", "ken@example.com", "", "Do you support multiple e-WorkPermit accounts in one install?", "127.0.0.1"]);
      console.log("✓ contact_messages: 2 ข้อความ");
    }
    const sum = await q("SELECT ym, SUM(runs) runs, SUM(billable_records) recs, SUM(amount_thb) amt FROM v_usage_monthly WHERE operator LIKE 'demo-%' GROUP BY ym ORDER BY ym DESC");
    console.log("สรุปจาก view v_usage_monthly:");
    for (const r of sum) console.log(`  ${r.ym}: ${r.runs} ครั้ง, ${r.recs} รายการ, ฿${Number(r.amt).toLocaleString("th-TH", { minimumFractionDigits: 2 })}`);
    console.log("ลบข้อมูลตัวอย่างออกได้ด้วย: node seed.js --clean");
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
