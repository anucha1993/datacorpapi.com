"use strict";
/**
 * ลิงก์ "ชำระเงิน / อัปเกรด / ต่ออายุ" ที่โปรแกรมของลูกค้าเปิดในเบราว์เซอร์ได้ทันที (ไม่ต้อง login)
 *   GET /pay/<token> → สร้าง Polar checkout ของแพ็กเกจเป้าหมาย แล้ว redirect ไปหน้าจ่ายเงิน
 * token ผูกกับ API key 1 ตัว + แพ็กเกจเป้าหมาย + วันหมดอายุ และลงลายเซ็นด้วย SESSION_SECRET (ปลอม/แก้ไม่ได้, ไม่มี key จริงใน URL)
 *
 * แพ็กเกจเป้าหมาย: แพ็กเกจทดลอง "X Trial" → "X" · แพ็กเกจที่จ่ายเงิน → แพ็กเกจเดิม (ต่ออายุ) · อื่น ๆ → ไม่มี (ส่งไปหน้าเลือกแพ็กเกจ)
 */
const crypto = require("crypto");
const platform = require("./platform");

const TTL_MS = 7 * 24 * 3600 * 1000;
const b64 = (s) => Buffer.from(s).toString("base64url");

function sign(secret, keyId, planId, ttl = TTL_MS) {
  const body = b64(JSON.stringify({ k: Number(keyId), p: Number(planId), e: Date.now() + ttl }));
  return body + "." + crypto.createHmac("sha256", secret).update(body).digest("base64url").slice(0, 32);
}
function verify(secret, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", secret).update(body).digest("base64url").slice(0, 32);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const d = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); return d.e > Date.now() ? d : null; } catch { return null; }
}

const isPaid = (pl) => pl && pl.billing !== "usage" && Number(pl.price_thb) > 0 && !!pl.polar_product_id;

/** แพ็กเกจที่ควรจ่าย/อัปเกรดไป จาก subscription ปัจจุบัน */
async function targetPlan(q, sub) {
  const cur = await platform.getPlan(q, sub.plan_id);
  if (!cur) return null;
  const m = /^(.*?)\s*trial$/i.exec(cur.name);
  if (m) {
    const base = (await q("SELECT id FROM product_plans WHERE product_id = ? AND name = ? LIMIT 1", [cur.product_id, m[1].trim()]))[0];
    const pl = base && await platform.getPlan(q, base.id);
    if (isPaid(pl)) return pl;
  }
  return isPaid(cur) ? cur : null;
}

/** key ของลูกค้า (ไม่สนสถานะแพ็กเกจ — ใช้ตอนหมดอายุแล้วก็ยังสร้างลิงก์จ่ายได้) */
async function keyOwner(q, rawKey) {
  const k = String(rawKey || "").trim();
  if (!k) return null;
  const r = await q(`SELECT k.id key_id, ${platform.SUB_SELECT.slice(7)} JOIN access_keys k ON k.subscription_id = s.id
                     WHERE k.key_hash = ? AND k.kind = 'api' AND k.revoked_at IS NULL LIMIT 1`, [platform.sha256(k)]);
  return r[0] || null;
}

/**
 * ลิงก์ทั้งหมดสำหรับ key นี้: { upgrade_url, upgrade_plan, upgrade_price_thb, pay_url, checkout_url, plans_url, portal_url }
 *   upgrade_url = /pay/<token> (จ่าย/อัปเกรด/ต่ออายุ ไม่ต้อง login) · pay_url/checkout_url = บิลที่ค้างชำระ (ถ้ามี)
 */
async function linksForKey(q, { secret, base, rawKey, owner = null }) {
  base = String(base || "").replace(/\/+$/, "");
  owner = owner || await keyOwner(q, rawKey);
  const out = { upgrade_url: null, upgrade_plan: null, upgrade_price_thb: null, pay_url: null, checkout_url: null, plans_url: `${base}/portal/plans`, portal_url: `${base}/portal` };
  if (!owner) return out;
  const t = await targetPlan(q, owner);
  if (t) Object.assign(out, { upgrade_url: `${base}/pay/${sign(secret, owner.key_id, t.id)}`, upgrade_plan: t.name, upgrade_price_thb: Number(t.price_thb) });
  const inv = (await q("SELECT invoice_no, checkout_url FROM billing_invoices WHERE operator = ? AND status = 'open' ORDER BY due_at, id LIMIT 1", [owner.operator]))[0];
  if (inv) Object.assign(out, { pay_url: `${base}/portal/invoices/${encodeURIComponent(inv.invoice_no)}`, checkout_url: inv.checkout_url || null });
  return out;
}
/** ลิงก์เดียวที่ควรเปิดเมื่อถูกบล็อกด้วย error นี้ */
function actionFor(error, links) {
  if (error === "payment_required") return links.checkout_url || links.pay_url || `${links.portal_url}/billing`;
  if (["inactive", "quota_exceeded", "license_expired", "no_license"].includes(error)) return links.upgrade_url || links.plans_url;
  return null;
}

module.exports = { sign, verify, targetPlan, keyOwner, linksForKey, actionFor, isPaid, TTL_MS };
