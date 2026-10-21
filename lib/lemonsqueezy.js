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

module.exports = { verifySignature, createUsageRecord, getCurrentUsage, getSubscription, buildCheckoutUrl };
