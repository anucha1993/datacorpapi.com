"use strict";
/**
 * ประมวลผล webhook ของ Lemon Squeezy → ตาราง billing_* และ ส่งยอดการใช้งานรายเดือนกลับไป LS
 */
const crypto = require("crypto");
const ls = require("./lemonsqueezy");
const invoices = require("./invoices");

const toDt = (iso) => (iso ? new Date(iso).toISOString().slice(0, 19).replace("T", " ") : null);
const str = (v, n = 190) => (v == null ? "" : String(v)).slice(0, n);

/** บันทึก event (คืน false ถ้าเคยรับ body เดียวกันแล้ว) */
async function recordEvent(q, rawBody, payload) {
  const hash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const eventName = str(payload.meta && payload.meta.event_name, 60);
  const r = await q(
    "INSERT IGNORE INTO billing_events (body_hash, event_name, object_type, object_id, payload) VALUES (?,?,?,?,?)",
    [hash, eventName, str(payload.data && payload.data.type, 30), str(payload.data && payload.data.id, 40), rawBody.toString("utf8")],
  );
  return r.affectedRows > 0;
}

async function upsertCustomer(q, a, custom) {
  if (!a.customer_id) return;
  const operator = str(custom.operator, 100);
  const company = str(custom.company);
  await q(
    `INSERT INTO billing_customers (customer_id, email, name, company, operator) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       email = VALUES(email), name = VALUES(name),
       company = IF(VALUES(company) <> '', VALUES(company), company),
       operator = IF(operator = '', VALUES(operator), operator)`,
    [a.customer_id, str(a.user_email), str(a.user_name), company, operator],
  );
}

async function handleWebhook(q, rawBody, payload) {
  const fresh = await recordEvent(q, rawBody, payload);
  if (!fresh) return { duplicate: true };
  const event = (payload.meta && payload.meta.event_name) || "";
  const custom = (payload.meta && payload.meta.custom_data) || {};
  const data = payload.data || {};
  const a = data.attributes || {};
  await upsertCustomer(q, a, custom);

  if (data.type === "subscriptions") {
    const item = a.first_subscription_item || {};
    await q(
      `INSERT INTO billing_subscriptions
         (subscription_id, customer_id, order_id, product_id, variant_id, product_name, variant_name, status, status_formatted,
          subscription_item_id, is_usage_based, renews_at, ends_at, trial_ends_at, customer_portal_url, update_payment_url, user_email, user_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         customer_id = VALUES(customer_id), order_id = VALUES(order_id), product_id = VALUES(product_id), variant_id = VALUES(variant_id),
         product_name = VALUES(product_name), variant_name = VALUES(variant_name), status = VALUES(status), status_formatted = VALUES(status_formatted),
         subscription_item_id = COALESCE(VALUES(subscription_item_id), subscription_item_id),
         is_usage_based = GREATEST(is_usage_based, VALUES(is_usage_based)),
         renews_at = VALUES(renews_at), ends_at = VALUES(ends_at), trial_ends_at = VALUES(trial_ends_at),
         customer_portal_url = IF(VALUES(customer_portal_url) <> '', VALUES(customer_portal_url), customer_portal_url),
         update_payment_url = IF(VALUES(update_payment_url) <> '', VALUES(update_payment_url), update_payment_url),
         user_email = VALUES(user_email), user_name = VALUES(user_name)`,
      [Number(data.id), a.customer_id || 0, a.order_id || null, a.product_id || null, a.variant_id || null,
       str(a.product_name), str(a.variant_name), str(a.status, 30), str(a.status_formatted, 40),
       item.id || null, item.is_usage_based ? 1 : 0, toDt(a.renews_at), toDt(a.ends_at), toDt(a.trial_ends_at),
       str(a.urls && a.urls.customer_portal, 500), str(a.urls && a.urls.update_payment_method, 500),
       str(a.user_email), str(a.user_name)],
    );
  } else if (data.type === "orders") {
    const fi = a.first_order_item || {};
    // LS ส่ง total เป็นหน่วยย่อย (เช่น สตางค์/เซนต์)
    const money = (v) => Math.round(Number(v || 0)) / 100;
    await q(
      `INSERT INTO billing_orders
         (order_id, customer_id, identifier, order_number, product_name, variant_name, status, currency, total, refunded_total, receipt_url, user_email, user_name, ordered_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status), total = VALUES(total), refunded_total = VALUES(refunded_total),
         receipt_url = IF(VALUES(receipt_url) <> '', VALUES(receipt_url), receipt_url),
         product_name = VALUES(product_name), variant_name = VALUES(variant_name), user_email = VALUES(user_email), user_name = VALUES(user_name)`,
      [Number(data.id), a.customer_id || 0, str(a.identifier, 64), a.order_number || null, str(fi.product_name), str(fi.variant_name),
       str(a.status, 30), str(a.currency, 3), money(a.total), money(a.refunded_amount), str(a.urls && a.urls.receipt, 500),
       str(a.user_email), str(a.user_name), toDt(a.created_at)],
    );
  }
  let invoicePaid = false;
  if (data.type === "orders") {
    try { invoicePaid = await invoices.applyOrderWebhook(q, payload); } catch (e) { console.error("[invoice webhook]", e.message); }
  }
  return { duplicate: false, event, invoicePaid };
}

/**
 * ส่งยอดการใช้งานเดือน ym ของทุก subscription แบบ usage-based ที่ active และผูก operator แล้ว
 * คืน list ผลลัพธ์ต่อ subscription
 */
module.exports = { handleWebhook };
