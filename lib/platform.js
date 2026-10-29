"use strict";
/**
 * แพลตฟอร์มขาย API Key / License Key (แบบ GitHub Copilot)
 *   products → product_plans (รายเดือน/รายปี/ตามใช้งาน) → subscriptions ของลูกค้า → access_keys
 *   โควตานับเป็นยอดรวมรายเดือนใน usage_counters (ไม่เก็บ log ต่อ request) รีเซ็ตทุกวันที่ 1
 *
 * ใช้จาก server.js (หน้าเว็บ + API) และ lib/billing.js (webhook ของ Polar)
 */
const crypto = require("crypto");

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const money = (v) => Math.round(Number(v || 0) * 100) / 100;
// รอบบิล: เริ่มวันที่ BILLING_CYCLE_DAY ของเดือน ถึงวันก่อนหน้าของเดือนถัดไป (เวลาไทย) — key ของรอบ = เดือนที่รอบเริ่ม
//   BILLING_CYCLE_DAY=23 → รอบ "2026-10" = 23 ต.ค. – 22 พ.ย. ตัดรอบ/ออกบิล 23 พ.ย. · ค่าเริ่มต้น 23 (ตั้ง 1 = เดือนปฏิทิน)
const CYCLE_DAY = Math.min(28, Math.max(1, Math.trunc(Number(process.env.BILLING_CYCLE_DAY) || 23)));
const keyOf = (y, m) => { const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
function periodOf(date = new Date()) {
  const t = new Date(date.getTime() + 7 * 3600e3); // UTC fields = เวลาไทย
  return keyOf(t.getUTCFullYear(), t.getUTCMonth() - (t.getUTCDate() < CYCLE_DAY ? 1 : 0));
}
const ymNow = () => periodOf();
/** { key, start, end, next } เป็น YYYY-MM-DD — next = วันตัดรอบ/ออกบิล */
function periodRange(key = ymNow()) {
  const [y, m] = String(key).split("-").map(Number);
  const f = (d) => d.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(y, m - 1, CYCLE_DAY)), next = new Date(Date.UTC(y, m, CYCLE_DAY));
  return { key, start: f(start), end: f(new Date(next.getTime() - 86400e3)), next: f(next) };
}
const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const cycleLabel = () => ordinal(CYCLE_DAY);
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const LIC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randStr = (n, chars) => { const b = crypto.randomBytes(n); let s = ""; for (let i = 0; i < n; i++) s += chars[b[i] % chars.length]; return s; };

const BILLING_LABELS = { month: "Monthly", year: "Yearly", usage: "Pay as you go" };
const SUB_STATUS = { pending: "Awaiting payment", active: "Active", past_due: "Payment failed", cancelled: "Cancelled", expired: "Expired" };

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------
function cleanSlug(v) {
  const s = String(v || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!s) throw new Error("Slug is required (letters, numbers and dashes)");
  return s;
}
function cleanProduct(d) {
  const name = String(d.name || "").trim().slice(0, 190);
  if (!name) throw new Error("Product name is required");
  const kind = d.kind === "license" ? "license" : "api";
  const docs = String(d.docs_url || "").trim().slice(0, 500);
  if (docs && !/^https?:\/\/\S+$/i.test(docs)) throw new Error("Docs URL must start with http:// or https://");
  return { slug: cleanSlug(d.slug || name), name, tagline: String(d.tagline || "").trim().slice(0, 255), description: String(d.description || "").trim().slice(0, 5000),
    kind, unit_label: String(d.unit_label || "").trim().slice(0, 40) || (kind === "license" ? "activations" : "requests"), docs_url: docs, sort_order: Math.trunc(Number(d.sort_order) || 0) };
}
async function saveProduct(q, id, d) {
  const p = cleanProduct(d);
  try {
    if (id) {
      await q("UPDATE products SET slug=?, name=?, tagline=?, description=?, kind=?, unit_label=?, docs_url=?, sort_order=? WHERE id=?",
        [p.slug, p.name, p.tagline, p.description, p.kind, p.unit_label, p.docs_url, p.sort_order, id]);
      return id;
    }
    const r = await q("INSERT INTO products (slug, name, tagline, description, kind, unit_label, docs_url, sort_order) VALUES (?,?,?,?,?,?,?,?)",
      [p.slug, p.name, p.tagline, p.description, p.kind, p.unit_label, p.docs_url, p.sort_order]);
    return r.insertId;
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") throw new Error(`Slug "${p.slug}" is already used by another product`);
    throw e;
  }
}
/** สร้าง service secret ใหม่ (แสดงครั้งเดียว) — backend ของบริการใช้เรียก /api/v1/authorize */
async function rotateServiceSecret(q, productId) {
  const secret = "dca_svc_" + randStr(40, ALNUM);
  await q("UPDATE products SET service_secret_hash = ? WHERE id = ?", [sha256(secret), productId]);
  return secret;
}

function cleanPlan(d, minThb) {
  const name = String(d.name || "").trim().slice(0, 120);
  if (!name) throw new Error("Plan name is required");
  const billing = ["month", "year", "usage"].includes(d.billing) ? d.billing : "month";
  const price = billing === "usage" ? 0 : money(d.price_thb);
  if (price < 0 || (price > 0 && price < minThb)) throw new Error(`Price must be 0 (free) or at least ฿${minThb}`);
  const incl = String(d.included_units ?? "").trim();
  const included = incl === "" ? null : Math.max(0, Math.trunc(Number(incl) || 0));
  const unitPrice = Math.max(0, Math.round(Number(d.unit_price_thb || 0) * 10000) / 10000);
  if (billing === "usage" && !(unitPrice > 0)) throw new Error("Pay-as-you-go plans need a price per unit");
  const polar = String(d.polar_product_id || "").trim().slice(0, 64);
  if (price > 0 && !polar) throw new Error("Paid monthly/yearly plans need the Polar product ID (a recurring product with the same price)");
  return { name, billing, price_thb: price, included_units: included, unit_price_thb: unitPrice,
    max_keys: Math.max(1, Math.trunc(Number(d.max_keys) || 1)), max_devices: Math.max(0, Math.trunc(Number(d.max_devices) || 0)),
    rate_limit_per_min: Math.max(0, Math.trunc(Number(d.rate_limit_per_min) || 0)), features: String(d.features || "").trim().slice(0, 3000),
    polar_product_id: polar, is_featured: d.is_featured ? 1 : 0, sort_order: Math.trunc(Number(d.sort_order) || 0),
    allowed_models: [].concat(d.allowed_models || []).map(s => String(s).trim()).filter(s => /^[A-Za-z0-9._:\/-]+$/.test(s)).join(",").slice(0, 1000),
    max_output_tokens: Math.max(0, Math.trunc(Number(d.max_output_tokens) || 0)),
    lifetime_free_units: Math.max(0, Math.trunc(Number(d.lifetime_free_units) || 0)),
    token_multiplier: Math.min(100, Math.max(0.01, Math.round((Number(d.token_multiplier) || 1) * 1000) / 1000)) };
}
async function savePlan(q, productId, id, d, minThb) {
  const p = cleanPlan(d, minThb);
  const cols = ["name", "billing", "price_thb", "included_units", "unit_price_thb", "max_keys", "max_devices", "rate_limit_per_min", "features", "polar_product_id", "is_featured", "sort_order", "allowed_models", "max_output_tokens", "lifetime_free_units", "token_multiplier"];
  if (id) await q(`UPDATE product_plans SET ${cols.map(c => c + " = ?").join(", ")} WHERE id = ? AND product_id = ?`, [...cols.map(c => p[c]), id, productId]);
  else await q(`INSERT INTO product_plans (product_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`, [productId, ...cols.map(c => p[c])]);
}

async function listProducts(q, { activeOnly = false } = {}) {
  const products = await q(`SELECT * FROM products ${activeOnly ? "WHERE is_active = 1" : ""} ORDER BY sort_order, name`);
  const plans = await q(`SELECT * FROM product_plans ${activeOnly ? "WHERE is_active = 1" : ""} ORDER BY sort_order, price_thb, id`);
  for (const p of products) p.plans = plans.filter(pl => pl.product_id === p.id);
  return products;
}
async function getPlan(q, planId) {
  const r = await q(`SELECT pl.*, p.name product_name, p.slug product_slug, p.kind, p.unit_label, p.is_active product_active
                     FROM product_plans pl JOIN products p ON p.id = pl.product_id WHERE pl.id = ?`, [Number(planId)]);
  return r[0] || null;
}

// ---------------------------------------------------------------------------
// subscriptions
// ---------------------------------------------------------------------------
const SUB_SELECT = `SELECT s.*, p.name product_name, p.slug product_slug, p.kind, p.unit_label, p.docs_url,
    pl.name plan_name, pl.billing, pl.price_thb, pl.included_units, pl.unit_price_thb, pl.max_keys, pl.max_devices, pl.rate_limit_per_min, pl.features, pl.allowed_models, pl.max_output_tokens
  FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN product_plans pl ON pl.id = s.plan_id`;

/** ใช้งานได้ไหม: active และยังไม่หมดรอบ */
function isLive(s, now = new Date()) {
  if (s.status !== "active") return false;
  if (!s.period_end) return true;
  const end = s.period_end instanceof Date ? s.period_end : new Date(String(s.period_end).replace(" ", "T") + "+07:00"); // DB เก็บเวลาไทย (timezone +07:00)
  return end > now;
}

async function listSubscriptions(q, operator) {
  const subs = await q(`${SUB_SELECT} WHERE s.operator = ? AND s.status <> 'expired' ORDER BY FIELD(s.status,'active','past_due','pending','cancelled'), s.created_at DESC`, [operator]);
  await attachUsage(q, subs);
  return subs;
}
async function getSubscription(q, id, operator = null) {
  const r = await q(`${SUB_SELECT} WHERE s.id = ? ${operator ? "AND s.operator = ?" : ""}`, operator ? [Number(id), operator] : [Number(id)]);
  if (!r[0]) return null;
  await attachUsage(q, r);
  return r[0];
}
/** เติมยอดใช้งานเดือนนี้ + จำนวน key */
async function attachUsage(q, subs) {
  if (!subs.length) return;
  const ids = subs.map(s => s.id), ym = ymNow();
  const [use, keys] = await Promise.all([
    q("SELECT subscription_id, units, requests FROM usage_counters WHERE ym = ? AND subscription_id IN (?)", [ym, ids]),
    q("SELECT subscription_id, COUNT(*) n FROM access_keys WHERE revoked_at IS NULL AND subscription_id IN (?) GROUP BY subscription_id", [ids]),
  ]);
  for (const s of subs) {
    const u = use.find(x => x.subscription_id === s.id);
    s.used = u ? Number(u.units) : 0;
    s.requests = u ? Number(u.requests) : 0;
    s.key_count = Number((keys.find(k => k.subscription_id === s.id) || {}).n || 0);
    s.live = isLive(s);
    s.included = s.included_units == null ? null : Number(s.included_units);
    s.pct = s.included ? Math.min(100, Math.round((s.used / s.included) * 100)) : 0;
  }
}

/** ลูกค้ามี subscription ของสินค้านี้ที่ยังใช้อยู่ไหม (กันซื้อซ้อน) */
async function activeForProduct(q, operator, productId) {
  const r = await q("SELECT * FROM subscriptions WHERE operator = ? AND product_id = ? AND status IN ('active','past_due') ORDER BY id DESC LIMIT 1", [operator, productId]);
  return r[0] || null;
}

/** สร้าง subscription รอชำระ (pending) — แพ็กเกจฟรี/ตามใช้งาน เปิดใช้ทันที */
async function createSubscription(q, operator, plan, { source = null, months = null, note = "" } = {}) {
  const freeStart = plan.billing === "usage" || Number(plan.price_thb) === 0;
  const src = source || (freeStart ? "free" : "polar");
  const active = src !== "polar";
  let end = null;
  if (active && months) { const d = new Date(); d.setMonth(d.getMonth() + Number(months)); end = d; }
  const r = await q(`INSERT INTO subscriptions (operator, product_id, plan_id, status, period_start, period_end, source, note) VALUES (?,?,?,?,?,?,?,?)`,
    [operator, plan.product_id, plan.id, active ? "active" : "pending", active ? new Date() : null, end, src, String(note).slice(0, 255)]);
  return r.insertId;
}
/** เปลี่ยนแพ็กเกจในสินค้าเดียวกัน (เช่น อัปเกรด Free → Pro ทำผ่าน checkout ใหม่ แล้วปิดอันเก่าใน webhook) */
async function setStatus(q, id, status, extra = {}) {
  const sets = ["status = ?"], params = [status];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); params.push(v); }
  await q(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------
function newApiKey() { const k = "dca_sk_" + randStr(36, ALNUM); return { key: k, prefix: k.slice(0, 12) }; }
function newLicenseKey() { const k = "DCL-" + [0, 1, 2, 3].map(() => randStr(4, LIC)).join("-"); return { key: k, prefix: k.slice(0, 9) }; }
const normLicense = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "");

async function listKeys(q, subscriptionId) {
  const keys = await q("SELECT id, kind, name, key_prefix, key_plain, last_used_at, revoked_at, created_at FROM access_keys WHERE subscription_id = ? ORDER BY revoked_at IS NOT NULL, id DESC", [subscriptionId]);
  const lic = keys.filter(k => k.kind === "license").map(k => k.id);
  const devs = lic.length ? await q("SELECT * FROM key_devices WHERE key_id IN (?) ORDER BY last_seen DESC", [lic]) : [];
  for (const k of keys) k.devices = devs.filter(d => d.key_id === k.id);
  return keys;
}
/** สร้าง key ใหม่ให้ subscription — คืน key เต็ม (API key แสดงได้ครั้งเดียว) */
async function createKey(q, sub, name = "") {
  if (!isLive(sub)) throw new Error("This subscription is not active");
  const n = (await q("SELECT COUNT(*) n FROM access_keys WHERE subscription_id = ? AND revoked_at IS NULL", [sub.id]))[0].n;
  if (Number(n) >= Number(sub.max_keys)) throw new Error(`Your plan allows ${sub.max_keys} active key${Number(sub.max_keys) === 1 ? "" : "s"}. Revoke one first or upgrade.`);
  const kind = sub.kind === "license" ? "license" : "api";
  for (let i = 0; i < 5; i++) {
    const k = kind === "license" ? newLicenseKey() : newApiKey();
    try {
      await q("INSERT INTO access_keys (operator, subscription_id, kind, name, key_prefix, key_hash, key_plain) VALUES (?,?,?,?,?,?,?)",
        [sub.operator, sub.id, kind, String(name || "").trim().slice(0, 100) || (kind === "license" ? "License" : "Default key"), k.prefix,
         sha256(kind === "license" ? normLicense(k.key) : k.key), kind === "license" ? k.key : null]);
      return k.key;
    } catch (e) { if (e.code !== "ER_DUP_ENTRY") throw e; }
  }
  throw new Error("Could not generate a unique key");
}
async function revokeKey(q, keyId, operator = null) {
  await q(`UPDATE access_keys SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL ${operator ? "AND operator = ?" : ""}`, operator ? [keyId, operator] : [keyId]);
}
async function removeDevice(q, deviceId, operator = null) {
  if (operator) await q("DELETE d FROM key_devices d JOIN access_keys k ON k.id = d.key_id WHERE d.id = ? AND k.operator = ?", [deviceId, operator]);
  else await q("DELETE FROM key_devices WHERE id = ?", [deviceId]);
}

// ---------------------------------------------------------------------------
// runtime: authorize + meter (เรียกจาก backend ของบริการ), license verify (เรียกจากโปรแกรม)
// ---------------------------------------------------------------------------
const rate = new Map();   // keyId → [timestamps] (ต่อ process)
function rateOk(keyId, perMin) {
  if (!perMin) return true;
  const now = Date.now(), arr = (rate.get(keyId) || []).filter(t => now - t < 60000);
  if (arr.length >= perMin) { rate.set(keyId, arr); return false; }
  arr.push(now); rate.set(keyId, arr);
  return true;
}
const fail = (status, error, message, extra = {}) => ({ ok: false, status, error, message, ...extra });

async function productBySecret(q, secret) {
  if (!secret) return null;
  const r = await q("SELECT * FROM products WHERE service_secret_hash = ? AND service_secret_hash <> '' LIMIT 1", [sha256(secret)]);
  return r[0] || null;
}

/** หา key + subscription + ตรวจว่าใช้ได้ */
async function resolveKey(q, rawKey, { kind, productId = null } = {}) {
  const k = kind === "license" ? normLicense(rawKey) : String(rawKey || "").trim();
  if (!k) return fail(401, "missing_key", "No key supplied");
  const rows = await q(`SELECT k.id key_id, k.revoked_at, ${SUB_SELECT.slice(7)} JOIN access_keys k ON k.subscription_id = s.id WHERE k.key_hash = ? AND k.kind = ? LIMIT 1`, [sha256(k), kind]);
  const s = rows[0];
  if (!s) return fail(401, "invalid_key", "Key not recognised");
  if (s.revoked_at) return fail(401, "revoked_key", "This key has been revoked");
  if (productId && s.product_id !== productId) return fail(403, "wrong_product", "This key is not valid for this product");
  if (s.status === "past_due") return fail(402, "payment_required", "Payment failed — update your payment method in the customer portal");
  if (!isLive(s)) return fail(403, "inactive", "Subscription is not active");
  const acct = (await q("SELECT is_active FROM portal_users WHERE operator = ? LIMIT 1", [s.operator]))[0];
  if (acct && !acct.is_active) return fail(403, "suspended", "This account is suspended — contact support");
  return { ok: true, sub: s };
}

function quotaInfo(sub, used) {
  const included = sub.included_units == null ? null : Number(sub.included_units);
  return { period: ymNow(), unit: sub.unit_label, used, included, remaining: included == null ? null : Math.max(0, included - used),
    overage_units: included == null ? 0 : Math.max(0, used - included), overage_price_thb: Number(sub.unit_price_thb) };
}

/**
 * ตรวจ API key แล้วนับการใช้งาน (units) ในคำสั่งเดียว
 * โควตาเต็ม + แพ็กเกจไม่คิดเงินส่วนเกิน → 429 quota_exceeded (ไม่นับ)
 */
async function authorize(q, product, rawKey, { units = 1, dryRun = false } = {}) {
  const n = Math.max(0, Math.trunc(Number(units) || 0));
  const r = await resolveKey(q, rawKey, { kind: "api", productId: product.id });
  if (!r.ok) return r;
  const s = r.sub, ym = ymNow();
  if (!rateOk(s.key_id, Number(s.rate_limit_per_min))) return fail(429, "rate_limited", `Rate limit is ${s.rate_limit_per_min} requests per minute`);
  const included = s.included_units == null ? null : Number(s.included_units);
  const hardCap = included != null && !(Number(s.unit_price_thb) > 0);
  await q("INSERT IGNORE INTO usage_counters (subscription_id, ym) VALUES (?, ?)", [s.id, ym]);
  if (!dryRun) {
    const upd = await q(`UPDATE usage_counters SET units = units + ?, requests = requests + 1 WHERE subscription_id = ? AND ym = ? ${hardCap ? "AND units + ? <= ?" : ""}`,
      hardCap ? [n, s.id, ym, n, included] : [n, s.id, ym]);
    if (!upd.affectedRows) {
      const used = Number((await q("SELECT units FROM usage_counters WHERE subscription_id = ? AND ym = ?", [s.id, ym]))[0].units);
      return fail(429, "quota_exceeded", `Monthly quota of ${included} ${s.unit_label} reached — resets on the ${cycleLabel()}, or upgrade your plan`, { quota: quotaInfo(s, used) });
    }
    await q("UPDATE access_keys SET last_used_at = NOW() WHERE id = ? AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL 1 MINUTE)", [s.key_id]);
  }
  const used = Number((await q("SELECT units FROM usage_counters WHERE subscription_id = ? AND ym = ?", [s.id, ym]))[0].units);
  if (dryRun && hardCap && used + n > included) return fail(429, "quota_exceeded", `Monthly quota of ${included} ${s.unit_label} reached`, { quota: quotaInfo(s, used) });
  return { ok: true, status: 200, customer: s.operator, subscription_id: s.id, product: s.product_slug, plan: s.plan_name, charged_units: dryRun ? 0 : n, quota: quotaInfo(s, used) };
}

/** นับการใช้งานหลังทำงานเสร็จ (เช่น AI gateway ที่รู้จำนวน credits หลังได้คำตอบ) — ไม่บล็อก */
async function addUsage(q, subscriptionId, keyId, units, ym = ymNow()) {
  const n = Math.max(0, Math.trunc(Number(units) || 0));
  await q(`INSERT INTO usage_counters (subscription_id, ym, units, requests) VALUES (?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE units = units + VALUES(units), requests = requests + 1`, [subscriptionId, ym, n]);
  if (keyId) await q("UPDATE access_keys SET last_used_at = NOW() WHERE id = ? AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL 1 MINUTE)", [keyId]);
}

/** สถานะโควตาของ key ตัวเอง (ลูกค้าเรียกด้วย API key ของตัวเอง) */
async function keyStatus(q, rawKey) {
  const r = await resolveKey(q, rawKey, { kind: "api" });
  if (!r.ok) return r;
  const s = r.sub;
  const u = await q("SELECT units FROM usage_counters WHERE subscription_id = ? AND ym = ?", [s.id, ymNow()]);
  return { ok: true, status: 200, product: s.product_slug, plan: s.plan_name, renews_at: s.period_end, quota: quotaInfo(s, u[0] ? Number(u[0].units) : 0) };
}

/** ตรวจ license key จากโปรแกรม + ผูกเครื่อง (จำกัดจำนวนเครื่องตามแพ็กเกจ) */
async function verifyLicense(q, { license_key, product = "", device_id = "", device_name = "", app_version = "", ip = "" }) {
  const r = await resolveKey(q, license_key, { kind: "license" });
  if (!r.ok) return r;
  const s = r.sub;
  if (product && product !== s.product_slug) return fail(403, "wrong_product", "This license is for a different product");
  if (device_id) {
    const dev = String(device_id).slice(0, 100);
    const known = await q("SELECT device_id FROM key_devices WHERE key_id = ?", [s.key_id]);
    if (Number(s.max_devices) > 0 && !known.some(d => d.device_id === dev) && known.length >= Number(s.max_devices))
      return fail(403, "device_limit", `Device limit reached (${s.max_devices}). Remove a device in the customer portal.`);
    await q(`INSERT INTO key_devices (key_id, device_id, device_name, app_version, ip) VALUES (?,?,?,?,?)
             ON DUPLICATE KEY UPDATE device_name = VALUES(device_name), app_version = VALUES(app_version), ip = VALUES(ip), last_seen = NOW()`,
      [s.key_id, dev, String(device_name).slice(0, 100), String(app_version).slice(0, 30), String(ip).slice(0, 64)]);
  }
  await q("UPDATE access_keys SET last_used_at = NOW() WHERE id = ?", [s.key_id]);
  return { ok: true, status: 200, customer: s.operator, product: s.product_slug, plan: s.plan_name, expires_at: s.period_end,
    cancel_at_period_end: !!s.cancel_at_period_end, max_devices: Number(s.max_devices), features: String(s.features || "").split(/\r?\n/).filter(Boolean) };
}

// ---------------------------------------------------------------------------
// Polar webhook: subscription.created / active / updated / canceled / uncanceled / revoked
// ---------------------------------------------------------------------------
const toDt = (iso) => (iso ? new Date(iso) : null);
const POLAR_STATUS = { incomplete: "pending", incomplete_expired: "expired", trialing: "active", active: "active", past_due: "past_due", unpaid: "past_due", canceled: "cancelled" };

async function applyPolarSubscription(q, type, data) {
  const md = data.metadata || {};
  const ref = Number(md.subscription_ref) || 0;
  let sub = (await q("SELECT * FROM subscriptions WHERE provider_sub_id = ? AND provider_sub_id <> '' LIMIT 1", [String(data.id)]))[0];
  if (!sub && ref) sub = (await q("SELECT * FROM subscriptions WHERE id = ? LIMIT 1", [ref]))[0];
  if (!sub) return false;
  let status = POLAR_STATUS[data.status] || sub.status;
  if (type === "subscription.revoked") status = "expired";
  // canceled แต่ยังไม่ถึงวันสิ้นสุด = ยกเลิกล่วงหน้า ยังใช้ได้จนครบรอบ
  if (status === "cancelled" && data.current_period_end && new Date(data.current_period_end) > new Date() && !data.ended_at) status = "active";
  // ลูกค้าเปลี่ยนแพ็กเกจใน Polar (product_id ใหม่) → ย้าย plan_id ตาม (เฉพาะแพ็กเกจของสินค้าเดียวกัน)
  let planId = sub.plan_id;
  if (data.product_id) {
    const pl = (await q("SELECT id FROM product_plans WHERE product_id = ? AND polar_product_id = ? LIMIT 1", [sub.product_id, String(data.product_id)]))[0];
    if (pl) planId = pl.id;
  }
  await q(`UPDATE subscriptions SET status = ?, plan_id = ?, provider_sub_id = ?, period_start = COALESCE(?, period_start), period_end = COALESCE(?, period_end), cancel_at_period_end = ?, source = 'polar' WHERE id = ?`,
    [status, planId, String(data.id), toDt(data.current_period_start), toDt(data.current_period_end), data.cancel_at_period_end ? 1 : 0, sub.id]);
  if (status === "active" && sub.status !== "active") await supersedeOthers(q, sub.operator, sub.product_id, sub.id);
  return true;
}

/**
 * อัปเกรด/เปลี่ยนแพ็กเกจในสินค้าเดียวกัน: เมื่ออันใหม่ active → ปิดอันเก่าของสินค้าเดียวกัน แล้วย้าย key ไปอันใหม่
 * (ลูกค้าไม่ต้องเปลี่ยน key ในโปรแกรม/โค้ด)
 */
async function supersedeOthers(q, operator, productId, newId) {
  const old = await q("SELECT id FROM subscriptions WHERE operator = ? AND product_id = ? AND id <> ? AND status IN ('active','past_due','pending')", [operator, productId, newId]);
  for (const o of old) {
    await q("UPDATE access_keys SET subscription_id = ? WHERE subscription_id = ? AND revoked_at IS NULL", [newId, o.id]);
    await q("UPDATE subscriptions SET status = 'cancelled', note = CONCAT(note, IF(note = '', '', ' | '), ?) WHERE id = ?", [`Replaced by #${newId}`, o.id]);
  }
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------
async function usageHistory(q, subscriptionId, months = 12) {
  return q("SELECT ym, units, requests FROM usage_counters WHERE subscription_id = ? ORDER BY ym DESC LIMIT ?", [subscriptionId, months]);
}

module.exports = {
  BILLING_LABELS, SUB_STATUS, sha256, ymNow, isLive, CYCLE_DAY, periodOf, periodRange, cycleLabel,
  saveProduct, rotateServiceSecret, savePlan, listProducts, getPlan,
  listSubscriptions, getSubscription, activeForProduct, createSubscription, setStatus, SUB_SELECT,
  listKeys, createKey, revokeKey, removeDevice,
  productBySecret, authorize, keyStatus, resolveKey, rateOk, addUsage, verifyLicense, usageHistory, applyPolarSubscription, supersedeOthers,
};
