"use strict";
/**
 * คิดเงินโปรแกรม E-work (e-WorkPermit Tools) แบบ license + token
 *   งาน 1 งาน → tokens = จำนวนรายการ × tokens_per_record (+ tokens_per_run ถ้างานสำเร็จ) ตามโหมด (ตาราง ework_token_rates)
 *   ฟรีครั้งเดียวต่อลูกค้า (product_plans.lifetime_free_units หรือ ework_accounts.free_tokens) → เกินแล้วนับเข้า usage_counters
 *   ของ subscription แพ็กเกจ E-work → ออกบิลรายเดือนตาม unit_price_thb ด้วย lib/invoices.js เหมือนแพ็กเกจอื่น
 *
 * โปรแกรมส่งงานมาที่ POST /api/v1/ework/usage พร้อม SN (โปรแกรมรุ่นเก่าเขียนลง usage_runs ตรง ๆ — chargePending คิดให้เหมือนกัน)
 */
const platform = require("./platform");

const SLUG = () => (process.env.EWORK_PRODUCT_SLUG || "e-work").trim();
const STATUSES = ["ok", "cancelled", "error"];
const MAX_ROWS = 200;

const str = (v, n) => String(v ?? "").slice(0, n);
const int = (v) => Math.max(0, Math.min(4294967295, Math.trunc(Number(v) || 0)));
const dt = (v) => (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(String(v || "")) ? String(v).replace("T", " ") : null);

async function product(q) {
  return (await q("SELECT * FROM products WHERE slug = ? LIMIT 1", [SLUG()]))[0] || null;
}
/** subscription E-work ล่าสุดของลูกค้า (active/past_due ก่อน) */
async function subscriptionFor(q, operator) {
  const p = await product(q);
  if (!p) return null;
  const r = await q(`${platform.SUB_SELECT} WHERE s.operator = ? AND s.product_id = ? AND s.status IN ('active','past_due')
                     ORDER BY FIELD(s.status,'active','past_due'), s.id DESC LIMIT 1`, [operator, p.id]);
  if (!r[0]) return null;
  const pl = (await q("SELECT lifetime_free_units FROM product_plans WHERE id = ?", [r[0].plan_id]))[0] || {};
  return { ...r[0], lifetime_free_units: Number(pl.lifetime_free_units || 0), live: platform.isLive(r[0]) };
}

async function rates(q) {
  return q("SELECT * FROM ework_token_rates ORDER BY tokens_per_record, mode");
}
function tokensFor(row, rate) {
  if (!rate) return 0;
  // งานที่ยกเลิก/error คิดตามจำนวนที่ทำไปแล้วจริง
  const recs = row.status === "ok" ? int(row.record_count) : Math.max(int(row.record_count), int(row.progress_done));
  return Math.ceil(recs * Number(rate.tokens_per_record) + (row.status === "ok" ? Number(rate.tokens_per_run) : 0));
}

/** รับงานจากโปรแกรม (operator มาจาก SN เสมอ ไม่เชื่อค่าที่โปรแกรมส่งมา) — กันซ้ำด้วย event_id */
async function ingest(q, operator, rows) {
  let accepted = 0, duplicates = 0, rejected = 0;
  for (const r of rows.slice(0, MAX_ROWS)) {
    const ev = str(r.event_id, 36), started = dt(r.started_at), finished = dt(r.finished_at) || started;
    if (!/^[0-9a-f-]{36}$/i.test(ev) || !started || !String(r.mode || "").trim()) { rejected++; continue; }
    const res = await q(`INSERT IGNORE INTO usage_runs (event_id, install_id, machine, windows_user, operator, app_version, mode, mode_group, ewp_username, accounts,
                           login_file, started_at, finished_at, duration_sec, status, record_count, progress_done, progress_total, out_file, error_msg)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ev, str(r.install_id, 36), str(r.machine, 64), str(r.windows_user, 64), operator, str(r.app_version, 20), str(r.mode, 40), str(r.mode_group, 20),
       str(r.ewp_username, 190), JSON.stringify(Array.isArray(r.accounts) ? r.accounts.slice(0, 200).map(a => str(a, 190)) : []), str(r.login_file, 255),
       started, finished, int(r.duration_sec), STATUSES.includes(r.status) ? r.status : "error", int(r.record_count), int(r.progress_done), int(r.progress_total),
       str(r.out_file, 255), str(r.error_msg, 2000)]);
    if (res.affectedRows) accepted++; else duplicates++;
  }
  return { accepted, duplicates, rejected };
}

/**
 * คิด token ของงานที่ยังไม่คิด (ทั้งที่มาจาก API และจากโปรแกรมรุ่นเก่า) — ปลอดภัยถ้ารันซ้ำ/พร้อมกัน:
 * จองแถวด้วย charged_at ก่อน แล้วค่อยบวกยอด (ยอดสะสมใช้ LAST_INSERT_ID ให้ได้ค่าหลังบวกแบบ atomic)
 */
let running = null;
function chargePending(q) {
  if (!running) running = doCharge(q).finally(() => { running = null; });
  return running;
}
async function doCharge(q) {
  const rows = await q("SELECT id, operator, mode, status, record_count, progress_done FROM usage_runs WHERE charged_at IS NULL ORDER BY id LIMIT 1000");
  if (!rows.length) return { charged: 0 };
  const rateBy = Object.fromEntries((await rates(q)).map(r => [r.mode, r]));
  const subs = new Map();
  let charged = 0;
  for (const row of rows) {
    const tokens = tokensFor(row, rateBy[row.mode]);
    const claim = await q("UPDATE usage_runs SET charged_at = NOW(), tokens = ? WHERE id = ? AND charged_at IS NULL", [tokens, row.id]);
    if (!claim.affectedRows) continue;
    charged++;
    if (!row.operator) continue;
    if (!subs.has(row.operator)) subs.set(row.operator, await subscriptionFor(q, row.operator));
    const sub = subs.get(row.operator);
    await q("INSERT IGNORE INTO ework_accounts (operator) VALUES (?)", [row.operator]);
    const upd = await q("UPDATE ework_accounts SET tokens_total = LAST_INSERT_ID(tokens_total + ?) WHERE operator = ?", [tokens, row.operator]);
    const total = Number(upd.insertId);
    const acct = (await q("SELECT free_tokens FROM ework_accounts WHERE operator = ?", [row.operator]))[0];
    const free = acct && acct.free_tokens != null ? Number(acct.free_tokens) : sub ? sub.lifetime_free_units : 0;
    const billable = Math.max(0, total - free) - Math.max(0, total - tokens - free);
    await q("UPDATE usage_runs SET billable_tokens = ?, subscription_id = ? WHERE id = ?", [billable, sub ? sub.id : null, row.id]);
    if (sub) await platform.addUsage(q, sub.id, null, billable);
  }
  return { charged };
}

/** สรุปยอดของลูกค้า (พอร์ทัล / ผลตรวจ SN / แอดมิน) */
async function summary(q, operator, sub = undefined) {
  if (sub === undefined) sub = await subscriptionFor(q, operator);
  const acct = (await q("SELECT * FROM ework_accounts WHERE operator = ?", [operator]))[0] || { tokens_total: 0, free_tokens: null };
  const ym = platform.ymNow();
  const m = (await q(`SELECT COUNT(*) runs, COALESCE(SUM(tokens), 0) tokens, COALESCE(SUM(billable_tokens), 0) billable
                      FROM usage_runs WHERE operator = ? AND charged_at IS NOT NULL AND DATE_FORMAT(charged_at, '%Y-%m') = ?`, [operator, ym]))[0];
  const free = acct.free_tokens != null ? Number(acct.free_tokens) : sub ? sub.lifetime_free_units : 0;
  const used = Number(acct.tokens_total), price = sub ? Number(sub.unit_price_thb) : 0;
  return {
    plan: sub ? sub.plan_name : null, status: sub ? (sub.live ? "active" : sub.status) : "none", subscription_id: sub ? sub.id : null,
    free_tokens: free, tokens_used_total: used, free_remaining: Math.max(0, free - used),
    month: ym, month_runs: Number(m.runs), month_tokens: Number(m.tokens), month_billable_tokens: Number(m.billable),
    price_per_token_thb: price, month_overage_thb: Math.round(Number(m.billable) * price * 100) / 100,
    monthly_fee_thb: sub ? Number(sub.price_thb) : 0, free_override: acct.free_tokens != null,
  };
}

/** ใช้ตอนตรวจ SN: ต้องมี license E-work ที่ใช้งานได้ (ถ้ายังไม่ได้ตั้งสินค้า e-work → ไม่บังคับ) */
async function licenseCheck(q, operator) {
  const p = await product(q);
  if (!p) return { ok: true };
  const sub = await subscriptionFor(q, operator);
  if (!sub) return { ok: false, error: "no_license", message: "This account has no E-work license — contact support or subscribe in the customer portal" };
  if (sub.status === "past_due") return { ok: false, error: "payment_required", message: "Payment failed — please pay your outstanding invoice in the customer portal" };
  if (!sub.live) return { ok: false, error: "license_expired", message: "Your E-work license has expired — please renew in the customer portal" };
  return { ok: true, sub };
}

async function saveRate(q, d) {
  const mode = String(d.mode || "").trim().slice(0, 40);
  if (!/^[a-z0-9_]+$/.test(mode)) throw new Error("Mode is required (letters, digits, underscore)");
  const per = Number(d.tokens_per_record), run = Number(d.tokens_per_run || 0);
  if (!(per >= 0) || !(run >= 0)) throw new Error("Tokens must be 0 or more");
  await q(`INSERT INTO ework_token_rates (mode, label, tokens_per_record, tokens_per_run) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE label = VALUES(label), tokens_per_record = VALUES(tokens_per_record), tokens_per_run = VALUES(tokens_per_run)`,
    [mode, String(d.label || "").trim().slice(0, 120), per, run]);
}
async function setFreeOverride(q, operator, value) {
  const v = String(value ?? "").trim();
  await q("INSERT IGNORE INTO ework_accounts (operator) VALUES (?)", [operator]);
  await q("UPDATE ework_accounts SET free_tokens = ? WHERE operator = ?", [v === "" ? null : int(v), operator]);
}

module.exports = { SLUG, MAX_ROWS, product, subscriptionFor, rates, tokensFor, ingest, chargePending, summary, licenseCheck, saveRate, setFreeOverride };
