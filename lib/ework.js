"use strict";
/**
 * คิดเงินโปรแกรม E-work (e-WorkPermit Tools) แบบ license + token
 *   งาน 1 งาน → tokens = จำนวนรายการ × tokens_per_record (+ tokens_per_run ถ้างานสำเร็จ) ตามโหมด (ตาราง ework_token_rates)
 *   × token_multiplier ของแพ็กเกจ (ปรับอัตรากินทั้งหมดได้ที่เดียว)
 *   โควตา 2 แบบ (ตั้งที่แพ็กเกจ):
 *     - รายเดือน: included_units ต่อเดือน (lifetime_free_units = 0) → ทุก token เข้า usage_counters, ส่วนเกินออกบิลวันที่ 1
 *     - ครั้งเดียว: lifetime_free_units (หรือ ework_accounts.free_tokens รายคน) → เฉพาะส่วนที่เกินเข้า usage_counters
 *   บิลส่วนเกินออกตาม unit_price_thb ด้วย lib/invoices.js เหมือนแพ็กเกจอื่น
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
  const pl = (await q("SELECT lifetime_free_units, token_multiplier FROM product_plans WHERE id = ?", [r[0].plan_id]))[0] || {};
  return { ...r[0], lifetime_free_units: Number(pl.lifetime_free_units || 0), token_multiplier: Number(pl.token_multiplier || 1), live: platform.isLive(r[0]) };
}

async function rates(q) {
  return q("SELECT * FROM ework_token_rates ORDER BY tokens_per_record, mode");
}
function tokensFor(row, rate, multiplier = 1) {
  if (!rate) return 0;
  // งานที่ยกเลิก/error คิดตามจำนวนที่ทำไปแล้วจริง
  const recs = row.status === "ok" ? int(row.record_count) : Math.max(int(row.record_count), int(row.progress_done));
  return Math.ceil((recs * Number(rate.tokens_per_record) + (row.status === "ok" ? Number(rate.tokens_per_run) : 0)) * multiplier - 1e-9);
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
    if (row.operator && !subs.has(row.operator)) subs.set(row.operator, await subscriptionFor(q, row.operator));
    const sub = row.operator ? subs.get(row.operator) : null;
    const tokens = tokensFor(row, rateBy[row.mode], sub ? sub.token_multiplier : 1);
    const claim = await q("UPDATE usage_runs SET charged_at = NOW(), tokens = ? WHERE id = ? AND charged_at IS NULL", [tokens, row.id]);
    if (!claim.affectedRows) continue;
    charged++;
    if (!row.operator) continue;
    await q("INSERT IGNORE INTO ework_accounts (operator) VALUES (?)", [row.operator]);
    const upd = await q("UPDATE ework_accounts SET tokens_total = LAST_INSERT_ID(tokens_total + ?) WHERE operator = ?", [tokens, row.operator]);
    const total = Number(upd.insertId);
    const acct = (await q("SELECT free_tokens FROM ework_accounts WHERE operator = ?", [row.operator]))[0];
    // รายเดือน → ทุก token นับเข้าโควตาเดือน (บิลหักส่วนที่รวมในแพ็กเกจให้เอง) / ครั้งเดียว → เฉพาะส่วนที่เกินฟรี
    const free = monthlyQuota(sub) ? 0 : acct && acct.free_tokens != null ? Number(acct.free_tokens) : sub ? sub.lifetime_free_units : 0;
    const billable = Math.max(0, total - free) - Math.max(0, total - tokens - free);
    await q("UPDATE usage_runs SET billable_tokens = ?, subscription_id = ? WHERE id = ?", [billable, sub ? sub.id : null, row.id]);
    if (sub) await platform.addUsage(q, sub.id, null, billable);
  }
  return { charged };
}

const monthlyQuota = (sub) => !!sub && !sub.lifetime_free_units && sub.included_units != null && Number(sub.included_units) > 0;

/** สรุปยอดของลูกค้า (พอร์ทัล / ผลตรวจ SN / แอดมิน) */
async function summary(q, operator, sub = undefined) {
  if (sub === undefined) sub = await subscriptionFor(q, operator);
  const acct = (await q("SELECT * FROM ework_accounts WHERE operator = ?", [operator]))[0] || { tokens_total: 0, free_tokens: null };
  const ym = platform.ymNow(), pr = platform.periodRange(ym);
  const m = (await q(`SELECT COUNT(*) runs, COALESCE(SUM(tokens), 0) tokens, COALESCE(SUM(billable_tokens), 0) billable
                      FROM usage_runs WHERE operator = ? AND charged_at >= ? AND charged_at < ?`, [operator, pr.start, pr.next]))[0];
  const price = sub ? Number(sub.unit_price_thb) : 0, used = Number(acct.tokens_total);
  const base = {
    plan: sub ? sub.plan_name : null, status: sub ? (sub.live ? "active" : sub.status) : "none", subscription_id: sub ? sub.id : null,
    month: ym, period_start: pr.start, period_end: pr.end, next_bill: pr.next, month_runs: Number(m.runs), tokens_used_total: used, price_per_token_thb: price,
    monthly_fee_thb: sub ? Number(sub.price_thb) : 0, token_multiplier: sub ? sub.token_multiplier : 1,
  };
  if (monthlyQuota(sub)) {
    // รายเดือน: ยอดเดือนนี้ = usage_counters (ตัวเดียวกับที่ใช้ออกบิล)
    const units = Number(((await q("SELECT units FROM usage_counters WHERE subscription_id = ? AND ym = ?", [sub.id, ym]))[0] || {}).units || 0);
    const included = Number(sub.included_units), over = Math.max(0, units - included);
    return { ...base, quota_type: "monthly", month_tokens: units, month_included: included, month_remaining: Math.max(0, included - units),
      month_billable_tokens: over, month_overage_thb: Math.round(over * price * 100) / 100,
      free_tokens: included, free_remaining: Math.max(0, included - units), free_override: false };
  }
  const free = acct.free_tokens != null ? Number(acct.free_tokens) : sub ? sub.lifetime_free_units : 0;
  return { ...base, quota_type: "one-time", month_tokens: Number(m.tokens), month_billable_tokens: Number(m.billable),
    month_overage_thb: Math.round(Number(m.billable) * price * 100) / 100,
    free_tokens: free, free_remaining: Math.max(0, free - used), free_override: acct.free_tokens != null };
}

/** ประมาณการ token ต่อเดือนด้วยอัตรา + ตัวคูณปัจจุบัน จากงานใน 30 วันล่าสุด (ไว้ปรับอัตราให้ได้ยอดที่ต้องการ) */
async function projection(q, operator, multiplier, rateBy = null) {
  rateBy = rateBy || Object.fromEntries((await rates(q)).map(r => [r.mode, r]));
  const rows = await q("SELECT mode, status, record_count, progress_done, started_at FROM usage_runs WHERE operator = ? AND started_at >= NOW() - INTERVAL 30 DAY ORDER BY started_at", [operator]);
  if (!rows.length) return { per_month: 0, days: 0, sample_tokens: 0 };
  const first = new Date(String(rows[0].started_at).replace(" ", "T") + "+07:00").getTime();
  const days = Math.min(30, Math.max(1, (Date.now() - first) / 86400000));
  const tokens = rows.reduce((t, r) => t + tokensFor(r, rateBy[r.mode], multiplier), 0);
  return { per_month: Math.round(tokens / days * 30), days: Math.round(days * 10) / 10, sample_tokens: tokens };
}

// ---------------------------------------------------------------------------
// เติม token เอง (เช่น การใช้งานก่อนมีเว็บ) — บันทึกเป็นแถว usage_runs mode = manual_adjustment ให้ตรวจสอบ/ยกเลิกได้
// ---------------------------------------------------------------------------
const MANUAL = "manual_adjustment";

async function addManual(q, operator, { tokens, ym, note = "", by = "" }) {
  const n = Math.trunc(Number(tokens) || 0);
  if (n <= 0 || n > 100000000) throw new Error("Tokens must be a whole number above 0");
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym || "")) ? String(ym) : platform.ymNow();
  if (month > platform.ymNow()) throw new Error("Month cannot be in the future");
  const sub = await subscriptionFor(q, operator);
  if (!sub) throw new Error(`${operator} has no AI Web Tools license — grant one first`);
  // รอบนี้ = เวลาปัจจุบัน / รอบก่อน = วันแรกของรอบนั้น (ยอดและบิลจะไปอยู่รอบนั้น)
  const at = month === platform.ymNow() ? null : `${platform.periodRange(month).start} 12:00:00`;
  const ev = require("crypto").randomUUID();
  await q(`INSERT INTO usage_runs (event_id, install_id, operator, mode, mode_group, started_at, finished_at, status, record_count, out_file, error_msg, tokens, charged_at)
           VALUES (?, 'admin', ?, ?, 'adjust', COALESCE(?, NOW()), COALESCE(?, NOW()), 'ok', 0, ?, ?, ?, COALESCE(?, NOW()))`,
    [ev, operator, MANUAL, at, at, String(by).slice(0, 255), String(note).slice(0, 2000), n, at]);
  const row = (await q("SELECT id FROM usage_runs WHERE event_id = ?", [ev]))[0];
  await q("INSERT IGNORE INTO ework_accounts (operator) VALUES (?)", [operator]);
  const upd = await q("UPDATE ework_accounts SET tokens_total = LAST_INSERT_ID(tokens_total + ?) WHERE operator = ?", [n, operator]);
  const total = Number(upd.insertId);
  const acct = (await q("SELECT free_tokens FROM ework_accounts WHERE operator = ?", [operator]))[0];
  const free = monthlyQuota(sub) ? 0 : acct && acct.free_tokens != null ? Number(acct.free_tokens) : sub.lifetime_free_units;
  const billable = Math.max(0, total - free) - Math.max(0, total - n - free);
  await q("UPDATE usage_runs SET billable_tokens = ?, subscription_id = ? WHERE id = ?", [billable, sub.id, row.id]);
  await platform.addUsage(q, sub.id, null, billable, month);
  return { id: row.id, tokens: n, billable, month };
}

async function undoManual(q, id) {
  const r = (await q("SELECT * FROM usage_runs WHERE id = ? AND mode = ?", [Number(id), MANUAL]))[0];
  if (!r) throw new Error("Adjustment not found");
  const month = platform.periodOf(new Date(String(r.charged_at).replace(" ", "T") + "+07:00"));
  if (r.subscription_id) await q("UPDATE usage_counters SET units = GREATEST(0, CAST(units AS SIGNED) - ?), requests = GREATEST(0, CAST(requests AS SIGNED) - 1) WHERE subscription_id = ? AND ym = ?",
    [Number(r.billable_tokens), r.subscription_id, month]);
  await q("UPDATE ework_accounts SET tokens_total = GREATEST(0, CAST(tokens_total AS SIGNED) - ?) WHERE operator = ?", [Number(r.tokens || 0), r.operator]);
  await q("DELETE FROM usage_runs WHERE id = ?", [r.id]);
  return { operator: r.operator, tokens: Number(r.tokens || 0), month };
}

async function manualList(q, limit = 30) {
  return q("SELECT id, operator, tokens, billable_tokens, error_msg note, out_file by_admin, charged_at, received_at FROM usage_runs WHERE mode = ? ORDER BY id DESC LIMIT ?", [MANUAL, limit]);
}

/**
 * ลิงก์ให้โปรแกรมของลูกค้าแสดงปุ่ม "ชำระเงิน / ต่ออายุ" — base = SITE_URL
 *   pay_url: หน้าใบแจ้งหนี้ค้างชำระในพอร์ทัล (ต้อง login, ใช้ได้เสมอ) · checkout_url: หน้าชำระเงินของ Polar โดยตรง (ไม่ต้อง login)
 */
async function billingInfo(q, operator, base) {
  base = String(base || "").replace(/\/+$/, "");
  const open = await q("SELECT invoice_no, amount_thb, due_at, checkout_url FROM billing_invoices WHERE operator = ? AND status = 'open' ORDER BY due_at, id", [operator]);
  const first = open[0];
  return {
    open_invoices: open.length,
    amount_due_thb: Math.round(open.reduce((t, r) => t + Number(r.amount_thb), 0) * 100) / 100,
    oldest_due: first ? String(first.due_at).slice(0, 10) : null,
    pay_url: first ? `${base}/portal/invoices/${encodeURIComponent(first.invoice_no)}` : `${base}/portal/billing`,
    checkout_url: first && first.checkout_url ? first.checkout_url : null,
    renew_url: `${base}/portal/plans`,
    portal_url: `${base}/portal`,
  };
}
/** ลิงก์ที่ควรเปิดเมื่อถูกบล็อก (แนบท้ายข้อความด้วย เพื่อให้โปรแกรมรุ่นเก่าที่แสดงแค่ message ก็เห็นลิงก์) */
function actionUrl(error, billing) {
  if (error === "payment_required") return billing.checkout_url || billing.pay_url;
  if (error === "no_license" || error === "license_expired" || error === "quota_exceeded") return billing.renew_url;
  return null;
}

/** ใช้ตอนตรวจ SN: ต้องมี license E-work ที่ใช้งานได้ (ถ้ายังไม่ได้ตั้งสินค้า e-work → ไม่บังคับ) */
async function licenseCheck(q, operator) {
  const p = await product(q);
  if (!p) return { ok: true };
  const sub = await subscriptionFor(q, operator);
  if (!sub) return { ok: false, error: "no_license", message: "This account has no E-work license — contact support or subscribe in the customer portal" };
  if (sub.status === "past_due") return { ok: false, error: "payment_required", message: "Payment failed — please pay your outstanding invoice in the customer portal" };
  if (!sub.live) return { ok: false, error: "license_expired", message: "Your E-work license has expired — please renew in the customer portal" };
  // แพ็กเกจที่ไม่คิดส่วนเกิน (เช่น ทดลองใช้) → หยุดเมื่อใช้ token ครบโควตา
  if (monthlyQuota(sub) && !(Number(sub.unit_price_thb) > 0)) {
    const used = Number(((await q("SELECT units FROM usage_counters WHERE subscription_id = ? AND ym = ?", [sub.id, platform.ymNow()]))[0] || {}).units || 0);
    if (used >= Number(sub.included_units))
      return { ok: false, error: "quota_exceeded", message: `All ${Number(sub.included_units).toLocaleString("en-US")} tokens of your ${sub.plan_name} plan are used — upgrade in the customer portal` };
  }
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

module.exports = { billingInfo, actionUrl, MANUAL, addManual, undoManual, manualList, SLUG, MAX_ROWS, product, subscriptionFor, rates, tokensFor, ingest, chargePending, summary, projection, licenseCheck, saveRate, setFreeOverride };
