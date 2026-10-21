"use strict";
/**
 * ประมวลผล webhook ของ Lemon Squeezy → ตาราง billing_* และ ส่งยอดการใช้งานรายเดือนกลับไป LS
 */
const crypto = require("crypto");
const ls = require("./lemonsqueezy");

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
  return { duplicate: false, event };
}

/**
 * ส่งยอดการใช้งานเดือน ym ของทุก subscription แบบ usage-based ที่ active และผูก operator แล้ว
 * คืน list ผลลัพธ์ต่อ subscription
 */
/** quantityMode: "amount" = ส่งยอดเงิน (บาท) เป็นจำนวนหน่วย — ตั้งราคาต่อหน่วยใน LS = ฿1 (รองรับราคาต่างกันแต่ละโหมด)
 *               "records" = ส่งจำนวนรายการ — ตั้งราคาต่อหน่วยใน LS เอง (ราคาเดียวทุกโหมด) */
async function reportUsage(q, ym, { apiKey, action = "set", only = null, quantityMode = "amount", log = () => {} } = {}) {
  const subs = await q(
    `SELECT s.subscription_id, s.subscription_item_id, s.status, s.user_email, c.operator
     FROM billing_subscriptions s JOIN billing_customers c ON c.customer_id = s.customer_id
     WHERE s.is_usage_based = 1 AND s.subscription_item_id IS NOT NULL
       AND s.status IN ('active','on_trial','past_due','cancelled')
       ${only ? "AND s.subscription_id = ?" : ""}`,
    only ? [only] : [],
  );
  const results = [];
  for (const s of subs) {
    const res = { subscription_id: s.subscription_id, email: s.user_email, operator: s.operator, quantity: 0, amount: 0, records: 0, ok: false, message: "" };
    if (!s.operator) { res.message = "ยังไม่ได้ผูกชื่อผู้ใช้งาน (operator)"; results.push(res); continue; }
    const rows = await q("SELECT SUM(billable_records) qty, SUM(amount_thb) amt FROM v_usage_monthly WHERE ym = ? AND operator = ?", [ym, s.operator]);
    res.records = Number((rows[0] && rows[0].qty) || 0);
    res.amount = Number((rows[0] && rows[0].amt) || 0);
    res.quantity = quantityMode === "records" ? res.records : Math.round(res.amount);
    try {
      const r = await ls.createUsageRecord(s.subscription_item_id, res.quantity, action, apiKey);
      res.ok = true;
      res.message = `ส่งแล้ว (${action}) usage-record id=${r && r.data ? r.data.id : "?"}`;
    } catch (e) {
      res.message = e.message;
    }
    await q(
      "INSERT INTO billing_usage_reports (subscription_id, ym, operator, quantity, amount_thb, action, ok, response) VALUES (?,?,?,?,?,?,?,?)",
      [s.subscription_id, ym, s.operator, res.quantity, res.amount, action, res.ok ? 1 : 0, res.message.slice(0, 2000)],
    );
    log(`[usage→LS] ${ym} ${s.operator} sub#${s.subscription_id} qty=${res.quantity} ${res.ok ? "✓" : "✗ " + res.message}`);
    results.push(res);
  }
  return results;
}

module.exports = { handleWebhook, reportUsage };
