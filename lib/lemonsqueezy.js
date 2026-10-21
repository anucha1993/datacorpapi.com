"use strict";
/**
 * Lemon Squeezy helpers
 *  - verifySignature: ตรวจ HMAC-SHA256 (hex) ของ raw body กับ header X-Signature
 *  - createUsageRecord: ส่งยอดการใช้งานเข้า subscription item (usage-based billing)
 *  - getCurrentUsage: อ่านยอดที่ LS จะเรียกเก็บรอบถัดไป
 *  - buildCheckoutUrl: ต่อ query สำหรับ prefill อีเมล + custom data (operator)
 */
const crypto = require("crypto");

const API = "https://api.lemonsqueezy.com/v1";

function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const digest = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
  const sig = Buffer.from(String(signatureHeader), "utf8");
  return digest.length === sig.length && crypto.timingSafeEqual(digest, sig);
}

async function api(method, path, body, apiKey) {
  if (!apiKey) throw new Error("LS_API_KEY ยังไม่ได้ตั้งค่า");
  const r = await fetch(API + path, {
    method,
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ไม่ใช่ JSON */ }
  if (!r.ok) {
    const msg = json && json.errors ? json.errors.map(e => e.detail || e.title).join("; ") : text.slice(0, 200);
    const err = new Error(`Lemon Squeezy API ${r.status}: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return json;
}

/** action: "set" (aggregation = most recent usage during period) หรือ "increment" (sum of usage) */
async function createUsageRecord(subscriptionItemId, quantity, action, apiKey) {
  return api("POST", "/usage-records", {
    data: {
      type: "usage-records",
      attributes: { quantity: Math.max(0, Math.round(Number(quantity) || 0)), action: action === "increment" ? "increment" : "set" },
      relationships: { "subscription-item": { data: { type: "subscription-items", id: String(subscriptionItemId) } } },
    },
  }, apiKey);
}

async function getCurrentUsage(subscriptionItemId, apiKey) {
  return api("GET", `/subscription-items/${subscriptionItemId}/current-usage`, null, apiKey);
}

async function getSubscription(subscriptionId, apiKey) {
  return api("GET", `/subscriptions/${subscriptionId}`, null, apiKey);
}

function buildCheckoutUrl(base, { email, name, operator, company } = {}) {
  if (!base) return "";
  const u = new URL(base);
  if (email) u.searchParams.set("checkout[email]", email);
  if (name) u.searchParams.set("checkout[name]", name);
  if (operator) u.searchParams.set("checkout[custom][operator]", operator);
  if (company) u.searchParams.set("checkout[custom][company]", company);
  return u.toString();
}

// ---- ค้นหา store / variant อัตโนมัติ (ใช้เมื่อไม่ได้ตั้ง LS_STORE_ID / LS_VARIANT_ID) ----
const _cache = {};
async function resolveStoreId(apiKey) {
  if (process.env.LS_STORE_ID) return String(process.env.LS_STORE_ID).trim();
  if (_cache.store) return _cache.store;
  const r = await api("GET", "/stores", null, apiKey);
  const s = r && r.data && r.data[0];
  if (!s) throw new Error("ไม่พบร้านใน Lemon Squeezy (ตรวจ LS_API_KEY)");
  _cache.store = String(s.id);
  return _cache.store;
}
async function resolveVariantId(apiKey) {
  if (process.env.LS_VARIANT_ID) return String(process.env.LS_VARIANT_ID).trim();
  if (_cache.variant) return _cache.variant;
  const r = await api("GET", "/variants?page[size]=50", null, apiKey);
  const list = (r && r.data) || [];
  // เลือก variant ของสินค้าที่เป็น single payment (ไม่ใช่ subscription) ตัวแรกที่ published
  const pick = list.find(v => v.attributes && !v.attributes.is_subscription && v.attributes.status === "published") || list[0];
  if (!pick) throw new Error("ไม่พบสินค้า/variant ใน Lemon Squeezy — สร้างสินค้าแบบ Single payment ก่อน");
  _cache.variant = String(pick.id);
  return _cache.variant;
}

/**
 * สร้าง checkout สำหรับบิล 1 ใบ: ยอดเงินตาม amountThb (custom_price หน่วยสตางค์) + เติมข้อมูลลูกค้า
 * คืน { id, url, test_mode }
 */
async function createCheckout({ amountThb, email, name, taxNumber, country, zip, custom = {}, productName, productDescription,
                                redirectUrl, receiptButtonText, receiptLinkUrl, receiptNote, expiresAt = null, testMode = false }) {
  const apiKey = (process.env.LS_API_KEY || "").trim();
  const [storeId, variantId] = await Promise.all([resolveStoreId(apiKey), resolveVariantId(apiKey)]);
  const checkout_data = { custom: Object.fromEntries(Object.entries(custom).map(([k, v]) => [k, String(v)])) };
  if (email) checkout_data.email = email;
  if (name) checkout_data.name = name;
  if (taxNumber) checkout_data.tax_number = taxNumber;
  if (country || zip) checkout_data.billing_address = { ...(country ? { country } : {}), ...(zip ? { zip } : {}) };
  const product_options = {};
  if (productName) product_options.name = productName;
  if (productDescription) product_options.description = productDescription;
  if (redirectUrl) product_options.redirect_url = redirectUrl;
  if (receiptButtonText) product_options.receipt_button_text = receiptButtonText;
  if (receiptLinkUrl) product_options.receipt_link_url = receiptLinkUrl;
  if (receiptNote) product_options.receipt_thank_you_note = receiptNote;
  const body = {
    data: {
      type: "checkouts",
      attributes: {
        custom_price: Math.round(Number(amountThb) * 100),
        checkout_data, product_options,
        checkout_options: { embed: true },
        expires_at: expiresAt, preview: false, test_mode: !!testMode,
      },
      relationships: {
        store: { data: { type: "stores", id: storeId } },
        variant: { data: { type: "variants", id: variantId } },
      },
    },
  };
  const r = await api("POST", "/checkouts", body, apiKey);
  return { id: r.data.id, url: r.data.attributes.url, test_mode: !!r.data.attributes.test_mode };
}

module.exports = { verifySignature, createUsageRecord, getCurrentUsage, getSubscription, buildCheckoutUrl, createCheckout, resolveStoreId, resolveVariantId };
