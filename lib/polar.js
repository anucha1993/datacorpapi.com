"use strict";
/**
 * Polar (polar.sh) helpers — Merchant of Record แทน Lemon Squeezy
 *  - createCheckout: สร้าง checkout session ต่อบิล 1 ใบ ด้วยราคา ad-hoc คงที่ (ยอดบิล, THB)
 *  - verifyWebhook:  ตรวจลายเซ็นแบบ Standard Webhooks (headers webhook-id / webhook-timestamp / webhook-signature)
 *                    รองรับทั้ง secret ยุคใหม่ (whsec_ + base64) และยุคเก่า (Polar HMAC: ใช้สตริงทั้งก้อนเป็น key)
 *  - generateOrderInvoice / getOrderInvoice: ออกใบเสร็จ/ใบแจ้งหนี้ PDF ของ order ให้ลูกค้าดาวน์โหลด
 *
 * env: POLAR_ACCESS_TOKEN (Organization Access Token), POLAR_WEBHOOK_SECRET, POLAR_PRODUCT_ID,
 *      POLAR_SERVER = production | sandbox
 */
const crypto = require("crypto");

const token = () => (process.env.POLAR_ACCESS_TOKEN || "").trim();
const isSandbox = () => /^(sandbox|test)$/i.test((process.env.POLAR_SERVER || "").trim());
const apiBase = () => (isSandbox() ? "https://sandbox-api.polar.sh" : "https://api.polar.sh");

async function api(method, path, body) {
  if (!token()) throw new Error("POLAR_ACCESS_TOKEN is not set");
  let r;
  try {
    r = await fetch(apiBase() + path, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    // "fetch failed" ไม่บอกสาเหตุ — ดึงรหัสจริงจาก e.cause (ENOTFOUND = DNS, ETIMEDOUT/ECONNREFUSED = firewall, CERT_* = ใบรับรอง SSL)
    const c = e.cause || e;
    throw new Error(`Cannot reach ${apiBase()} from this server (${c.code || c.name || "error"}: ${c.message || e.message})`);
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!r.ok) {
    let msg = text.slice(0, 300);
    if (json && json.detail) msg = Array.isArray(json.detail) ? json.detail.map(d => `${(d.loc || []).join(".")}: ${d.msg}`).join("; ") : String(json.detail);
    else if (json && json.error_description) msg = json.error_description;
    const err = new Error(`Polar API ${r.status}: ${msg}`);
    err.status = r.status; err.body = json;
    throw err;
  }
  return json;
}

const _cache = {};
/** product ที่ใช้ออกบิล — ตั้ง POLAR_PRODUCT_ID หรือให้ระบบหยิบสินค้าแบบจ่ายครั้งเดียวตัวแรกที่ไม่ archived */
async function resolveProductId() {
  const fixed = (process.env.POLAR_PRODUCT_ID || "").trim();
  if (fixed) return fixed;
  if (_cache.product) return _cache.product;
  const r = await api("GET", "/v1/products/?is_archived=false&limit=50");
  const list = (r && r.items) || [];
  const pick = list.find(p => !p.is_recurring) || list[0];
  if (!pick) throw new Error("No product found in Polar — create a one-time product first (or set POLAR_PRODUCT_ID)");
  _cache.product = pick.id;
  return pick.id;
}

/**
 * สร้าง checkout สำหรับบิล 1 ใบ — ยอดคงที่ตาม amountThb (หน่วยสตางค์) ลูกค้าแก้ยอดไม่ได้
 * ถ้า Polar ไม่รับราคา ad-hoc (เช่น องค์กรยังไม่เปิด THB) จะลองแบบ pay-what-you-want (amount) กับสินค้าเดิมแทน
 * คืน { id, url, test_mode, expires_at }
 */
async function createCheckout({ amountThb, email, name, taxNumber, country, zip, address, customerKey, custom = {}, successUrl }) {
  const productId = await resolveProductId();
  const satang = Math.round(Number(amountThb) * 100);
  const metadata = Object.fromEntries(Object.entries(custom).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 500)]));
  const base = {
    products: [productId],
    metadata,
    allow_discount_codes: false,
    require_billing_address: true,
  };
  if (email) base.customer_email = email;
  if (name) { base.customer_name = String(name).slice(0, 256); base.customer_billing_name = String(name).slice(0, 256); }
  if (customerKey) base.external_customer_id = String(customerKey).slice(0, 100);
  if (country) {
    base.customer_billing_address = { country: String(country).toUpperCase().slice(0, 2) };
    if (zip) base.customer_billing_address.postal_code = String(zip).slice(0, 16);
    if (address) base.customer_billing_address.line1 = String(address).replace(/\s+/g, " ").slice(0, 190);
  }
  if (successUrl) base.success_url = successUrl;

  const attempts = [
    // 1) ราคา ad-hoc คงที่ในสกุล THB (ลูกค้าแก้ยอดไม่ได้) — วิธีหลัก
    { ...base, currency: "thb", prices: { [productId]: [{ amount_type: "fixed", price_amount: satang, price_currency: "thb" }] }, ...(taxNumber ? { customer_tax_id: String(taxNumber) } : {}) },
    // 2) เหมือน 1) แต่ไม่ส่ง tax id (Polar ตรวจรูปแบบเลขภาษีเข้มงวด)
    { ...base, currency: "thb", prices: { [productId]: [{ amount_type: "fixed", price_amount: satang, price_currency: "thb" }] } },
    // 3) สินค้าแบบ pay-what-you-want: ตั้งยอดเริ่มต้นเท่ายอดบิล
    { ...base, currency: "thb", amount: satang },
  ];
  let lastErr = null;
  for (const body of attempts) {
    try {
      const r = await api("POST", "/v1/checkouts/", body);
      return { id: r.id, url: r.url, test_mode: isSandbox(), expires_at: r.expires_at || null };
    } catch (e) {
      lastErr = e;
      if (e.status !== 422) throw e;  // ปัญหาอื่น (token ผิด/เครือข่าย) ไม่ต้องลองต่อ
    }
  }
  throw lastErr;
}

/**
 * checkout ของแพ็กเกจรายเดือน/รายปี — ใช้สินค้าแบบ recurring ใน Polar ตามราคาที่ตั้งไว้ใน Polar
 * metadata ถูกคัดลอกไปที่ subscription/order → webhook ใช้ subscription_ref หา subscription ของเรา
 */
async function createSubscriptionCheckout({ productId, email, name, customerKey, metadata = {}, successUrl, taxNumber }) {
  const body = {
    products: [productId],
    metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 500)])),
    allow_discount_codes: true,
    require_billing_address: true,
  };
  if (email) body.customer_email = email;
  if (name) { body.customer_name = String(name).slice(0, 256); body.customer_billing_name = String(name).slice(0, 256); }
  if (customerKey) body.external_customer_id = String(customerKey).slice(0, 100);
  if (successUrl) body.success_url = successUrl;
  try {
    const r = await api("POST", "/v1/checkouts/", taxNumber ? { ...body, customer_tax_id: String(taxNumber) } : body);
    return { id: r.id, url: r.url };
  } catch (e) {
    if (e.status !== 422 || !taxNumber) throw e;   // Polar ตรวจรูปแบบเลขภาษีเข้มงวด → ลองใหม่โดยไม่ส่ง
    const r = await api("POST", "/v1/checkouts/", body);
    return { id: r.id, url: r.url };
  }
}
/** ยกเลิกเมื่อครบรอบ (true) / กลับมาต่ออายุ (false) */
async function setCancelAtPeriodEnd(subscriptionId, cancel) {
  return api("PATCH", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: !!cancel });
}
/** ยุติทันที (แอดมิน) */
async function revokeSubscription(subscriptionId) {
  return api("PATCH", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { revoke: true });
}
/** ลิงก์ Customer Portal ของ Polar (เปลี่ยนบัตร ดูใบเสร็จ) สำหรับลูกค้าคนนี้ */
async function customerPortalUrl(customerKey) {
  const r = await api("POST", "/v1/customer-sessions/", { external_customer_id: String(customerKey) });
  return (r && r.customer_portal_url) || "";
}

async function getOrder(orderId) { return api("GET", `/v1/orders/${encodeURIComponent(orderId)}`); }

/** ขอให้ Polar ออกเอกสารใบเสร็จ/ใบแจ้งหนี้ของ order (202 = กำลังสร้าง) แล้วดึง URL */
async function generateOrderInvoice(orderId) {
  try { await api("POST", `/v1/orders/${encodeURIComponent(orderId)}/invoice`, {}); }
  catch (e) { if (e.status !== 409 && e.status !== 422) throw e; } // 409/422 = สร้างแล้ว หรือข้อมูลที่อยู่ไม่ครบ
}
async function getOrderInvoice(orderId) {
  try {
    const r = await api("GET", `/v1/orders/${encodeURIComponent(orderId)}/invoice`);
    return (r && (r.url || r.invoice_url)) || "";
  } catch (e) {
    if (e.status === 404) return "";
    throw e;
  }
}

/**
 * ตรวจลายเซ็น webhook (Standard Webhooks) — signed = `${id}.${timestamp}.${rawBody}`
 * header webhook-signature อาจมีหลายค่า คั่นด้วยช่องว่าง รูปแบบ "v1,<base64>"
 * key ที่ลอง: base64-decode(secret หลังตัด whsec_) และ utf8(secret ทั้งก้อน) (รูปแบบเก่า)
 */
function verifyWebhook(rawBody, headers, secret, { toleranceSec = 300 } = {}) {
  if (!secret) return false;
  const h = (n) => String(headers[n] || headers[n.toLowerCase()] || "");
  const id = h("webhook-id"), ts = h("webhook-timestamp"), sigHeader = h("webhook-signature");
  if (!id || !ts || !sigHeader) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const signed = Buffer.concat([Buffer.from(`${id}.${ts}.`, "utf8"), body]);
  const keys = [];
  const stripped = secret.replace(/^whsec_/, "");
  try { const k = Buffer.from(stripped, "base64"); if (k.length) keys.push(k); } catch { /* ignore */ }
  keys.push(Buffer.from(secret, "utf8"));
  const given = sigHeader.split(/\s+/).map(s => s.trim()).filter(Boolean)
    .map(s => (s.includes(",") ? s.split(",", 2)[1] : s));
  for (const key of keys) {
    const expected = crypto.createHmac("sha256", key).update(signed).digest("base64");
    for (const g of given) {
      const a = Buffer.from(expected, "utf8"), b = Buffer.from(g, "utf8");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

/** สร้าง header ลายเซ็นสำหรับทดสอบ (ใช้ใน test เท่านั้น) */
function signForTest(rawBody, secret, id = "msg_test", ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = crypto.createHmac("sha256", key).update(`${id}.${ts}.`).update(rawBody).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` };
}

module.exports = { api, apiBase, isSandbox, resolveProductId, createCheckout, createSubscriptionCheckout, setCancelAtPeriodEnd, revokeSubscription, customerPortalUrl, getOrder, generateOrderInvoice, getOrderInvoice, verifyWebhook, signForTest };
