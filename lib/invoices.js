"use strict";
/**
 * ใบแจ้งหนี้ — ค่าใช้งานเกินโควตา/จ่ายตามใช้งานรายเดือน (ต่อ subscription), บิลบริการ/ระบุยอดเอง, ค่าสมาชิกที่ Polar ตัดบัตร
 * ผ่านผู้ให้บริการรับชำระเงิน (Polar หรือ Lemon Squeezy — เลือกใน lib/payments.js) ลูกค้ากดจ่ายในพอร์ทัล webhook มาร์คชำระแล้ว
 */
const payments = require("./payments");
const polar = require("./polar");

const MIN_THB = Number(process.env.INVOICE_MIN_THB || 17);     // ขั้นต่ำของผู้ให้บริการรับชำระเงิน (Lemon Squeezy ≈ ฿16.83, Polar/Stripe ≈ ฿10)
const DUE_DAYS = Number(process.env.INVOICE_DUE_DAYS || 15);

const money = (v) => Math.round(Number(v || 0) * 100) / 100;

function prevMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function nextInvoiceNo(q, ym) {
  const prefix = `INV-${ym.replace("-", "")}-`;
  const rows = await q("SELECT invoice_no FROM billing_invoices WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1", [prefix + "%"]);
  const last = rows[0] ? Number(rows[0].invoice_no.slice(prefix.length)) || 0 : 0;
  return prefix + String(last + 1).padStart(4, "0");
}

/** ข้อมูลลูกค้าสำหรับเติมหน้าชำระเงิน */
async function customerInfo(q, operator) {
  const rows = await q("SELECT * FROM portal_users WHERE operator = ? LIMIT 1", [operator]);
  const u = rows[0] || {};
  return {
    email: u.billing_email || u.email || "",
    name: u.company_name || u.display_name || operator,
    taxNumber: u.tax_id || "",
    country: u.country || "TH",
    zip: u.zip || "",
    address: u.address || "",
  };
}

/** สร้าง/อัปเดตลิงก์ชำระเงินของบิล (ใช้ผู้ให้บริการที่เลือกใน lib/payments.js — ต้องตั้ง token/API key ของเจ้านั้น) */
async function createCheckoutForInvoice(q, inv, opts = {}) {
  const info = await customerInfo(q, inv.operator);
  const siteUrl = (process.env.SITE_URL || "").replace(/\/+$/, "");
  const product = (process.env.PRODUCT_NAME || "DataCorp API").trim();
  const label = `${product} — ${inv.title || (inv.kind === "usage" ? "Usage " + inv.ym : "Invoice")} (${inv.invoice_no})`;
  const r = await payments.createCheckout({
    amountThb: inv.amount_thb,
    email: info.email, name: info.name, taxNumber: info.taxNumber, country: info.country, zip: info.zip, address: info.address,
    customerKey: inv.operator,
    custom: { invoice_id: String(inv.id), invoice_no: inv.invoice_no, operator: inv.operator, ym: inv.ym },
    label,
    description: inv.kind === "manual" ? (inv.note || inv.title || "") : `${inv.note || ""}${Number(inv.carried_thb) ? ` · carried forward ฿${inv.carried_thb}` : ""}${Number(inv.adjust_thb) ? ` · adjustment ฿${inv.adjust_thb}` : ""}`,
    successUrl: siteUrl ? `${siteUrl}/portal/billing?paid=${inv.invoice_no}` : undefined,
    portalUrl: siteUrl ? `${siteUrl}/portal/login` : undefined,
    note: `Payment for invoice ${inv.invoice_no} (${inv.ym})`,
    testMode: opts.testMode,
  });
  await q("UPDATE billing_invoices SET checkout_id = ?, checkout_url = ?, checkout_test = ?, provider = ? WHERE id = ?", [r.id, r.url, r.test_mode ? 1 : 0, r.provider, inv.id]);
  return r;
}

/**
 * ออกบิลค่าใช้งานเกินโควตา / แบบจ่ายตามใช้งาน ของเดือน ym — 1 ใบต่อ subscription
 *   ยอด = max(0, ใช้จริง − โควตาที่รวมในแพ็กเกจ) × ราคาต่อหน่วย  (แพ็กเกจที่ราคาต่อหน่วย = 0 ไม่มีบิลนี้)
 * - มีบิล paid/void แล้ว → ข้าม
 * - มีบิล open อยู่ → คำนวณใหม่ (ถ้าเดือนยังไม่จบยอดอาจเปลี่ยน) และสร้างลิงก์ใหม่ถ้ายอดเปลี่ยน
 * - ยอดต่ำกว่าขั้นต่ำของผู้ให้บริการรับชำระเงิน → carried ยกไปรวมเดือนถัดไป
 */
async function generateInvoices(q, ym, { only = null, apiReady = false, testMode = false, log = () => {} } = {}) {
  const subs = await q(`SELECT s.id, s.operator, p.name product_name, p.unit_label, pl.name plan_name, pl.included_units, pl.unit_price_thb, COALESCE(c.units, 0) units
                        FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN product_plans pl ON pl.id = s.plan_id
                        LEFT JOIN usage_counters c ON c.subscription_id = s.id AND c.ym = ?
                        WHERE pl.unit_price_thb > 0 ${only ? "AND s.operator = ?" : ""}
                          AND (c.units > 0 OR EXISTS (SELECT 1 FROM billing_invoices b WHERE b.subscription_id = s.id AND b.status = 'carried' AND b.ym < ?))`,
    only ? [ym, only, ym] : [ym, ym]);

  const results = [];
  for (const s of subs) {
    const included = s.included_units == null ? Infinity : Number(s.included_units);
    const billable = Math.max(0, Number(s.units) - included);
    const usage = money(billable * Number(s.unit_price_thb));
    const res = { operator: s.operator, subscription_id: s.id, ym, records: billable, usage, carried: 0, amount: 0, status: "", invoice_no: "", message: "" };
    try {
      const existing = (await q("SELECT * FROM billing_invoices WHERE subscription_id = ? AND ym = ? AND kind = 'usage' LIMIT 1", [s.id, ym]))[0];
      if (existing && (existing.status === "paid" || existing.status === "void")) {
        Object.assign(res, { status: existing.status, invoice_no: existing.invoice_no, amount: Number(existing.amount_thb), message: "Already exists (unchanged)" });
        results.push(res); continue;
      }
      const carried = existing ? Number(existing.carried_thb)
        : money((await q("SELECT COALESCE(SUM(amount_thb),0) s FROM billing_invoices WHERE subscription_id = ? AND status = 'carried' AND ym < ?", [s.id, ym]))[0].s);
      const adjust = existing ? Number(existing.adjust_thb) : 0;
      const amount = money(usage + carried + adjust);
      const status = amount <= 0 ? "void" : amount < MIN_THB ? "carried" : "open";
      Object.assign(res, { carried, amount, status });
      if (!existing && amount <= 0) { res.message = "Nothing to bill (within included quota)"; results.push(res); continue; }
      const title = `${s.product_name} · ${s.plan_name} — usage ${ym}`;
      const note = `${Number(s.units).toLocaleString("en-US")} ${s.unit_label} used` + (included === Infinity ? "" : `, ${included.toLocaleString("en-US")} included`) + ` · ฿${Number(s.unit_price_thb)} per ${s.unit_label.replace(/s$/, "")}`;
      let inv;
      if (!existing) {
        const invoice_no = await nextInvoiceNo(q, ym);
        const due = new Date(); due.setDate(due.getDate() + DUE_DAYS);
        await q(`INSERT INTO billing_invoices (invoice_no, operator, ym, kind, subscription_id, records, usage_thb, carried_thb, adjust_thb, amount_thb, status, title, note, due_at)
                 VALUES (?,?,?,'usage',?,?,?,?,?,?,?,?,?,?)`, [invoice_no, s.operator, ym, s.id, billable, usage, carried, adjust, amount, status, title, note, due.toISOString().slice(0, 10)]);
        // บิลที่ยกมา ถูกรวมแล้ว → ปิดเป็น void พร้อมหมายเหตุ
        if (carried > 0) await q("UPDATE billing_invoices SET status = 'void', note = CONCAT(note, ' → merged into ', ?) WHERE subscription_id = ? AND status = 'carried' AND ym < ?", [invoice_no, s.id, ym]);
        inv = (await q("SELECT * FROM billing_invoices WHERE invoice_no = ?", [invoice_no]))[0];
        res.message = "Invoice created";
      } else {
        const changed = Number(existing.amount_thb) !== amount || Number(existing.records) !== billable || existing.status !== status;
        await q("UPDATE billing_invoices SET records = ?, usage_thb = ?, amount_thb = ?, status = ?, title = ?, note = ? WHERE id = ?", [billable, usage, amount, status, title, note, existing.id]);
        inv = { ...existing, records: billable, usage_thb: usage, amount_thb: amount, status, title, note };
        res.message = changed ? "Amount updated" : "Unchanged";
        if (!changed && inv.checkout_url) { res.invoice_no = inv.invoice_no; results.push(res); continue; }
      }
      res.invoice_no = inv.invoice_no;
      if (status === "open") {
        if (apiReady) {
          try { await createCheckoutForInvoice(q, inv, { testMode }); res.message += " + payment link"; }
          catch (e) { res.message += ` (payment link failed: ${e.message})`; }
        } else res.message += ` (${payments.info().envApi} not set — no payment link)`;
      } else if (status === "carried") res.message += ` (below ฿${MIN_THB} minimum — carried to next month)`;
      log(`[invoice] ${ym} ${s.operator} sub#${s.id} ${res.invoice_no} ฿${amount} ${status} — ${res.message}`);
    } catch (e) {
      res.message = "ERROR: " + e.message;
    }
    results.push(res);
  }
  return results;
}

/**
 * ค่าสมาชิกรายเดือน/รายปีที่ Polar ตัดบัตรแล้ว (order ที่มี subscription_id) → บันทึกเป็นบิล paid เพื่อให้ลูกค้าเห็นประวัติ + ใบเสร็จ
 * idempotent ด้วย provider_order_id
 */
async function recordSubscriptionOrder(q, order) {
  if (!order || !order.subscription_id) return false;
  const paid = order.paid === true || order.status === "paid";
  if (!paid) return false;
  if ((await q("SELECT id FROM billing_invoices WHERE provider_order_id = ? LIMIT 1", [String(order.id)]))[0]) { await storePolarReceipt(q, order.id); return true; }
  const md = order.metadata || {};
  const sub = (await q(`SELECT s.id, s.operator, p.name product_name, pl.name plan_name, pl.billing FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN product_plans pl ON pl.id = s.plan_id
                        WHERE s.provider_sub_id = ? OR s.id = ? ORDER BY s.provider_sub_id = ? DESC LIMIT 1`,
    [String(order.subscription_id), Number(md.subscription_ref) || 0, String(order.subscription_id)]))[0];
  if (!sub) return false;
  const amount = money(Number(order.total_amount ?? order.amount ?? 0) / 100);
  const ym = new Date().toISOString().slice(0, 7);
  const invoice_no = await nextInvoiceNo(q, ym);
  await q(`INSERT INTO billing_invoices (invoice_no, operator, ym, kind, subscription_id, amount_thb, adjust_thb, status, title, note, paid_at, paid_via, provider, provider_order_id, due_at)
           VALUES (?,?,?,'subscription',?,?,?,'paid',?,?,NOW(),'polar','polar',?,CURDATE())`,
    [invoice_no, sub.operator, ym, sub.id, amount, amount, `${sub.product_name} · ${sub.plan_name}`.slice(0, 190),
     `${sub.billing === "year" ? "Yearly" : "Monthly"} subscription${order.billing_reason === "subscription_cycle" ? " renewal" : ""}`, String(order.id)]);
  if (!order.is_invoice_generated) { try { await polar.generateOrderInvoice(order.id); } catch (e) { console.error("[polar invoice]", e.message); } }
  await storePolarReceipt(q, order.id);
  return true;
}

/** ลิงก์ชำระเงินแบบแปะเอง (Polar checkout link ของบริการ) + เติมอีเมล/ชื่อ/เลขบิลให้ลูกค้า */
async function applyPaymentLink(q, inv, link) {
  const info = await customerInfo(q, inv.operator);
  const url = require("./services").linkForInvoice(link, inv, { email: info.email, name: info.name });
  await q("UPDATE billing_invoices SET checkout_id = '', checkout_url = ?, checkout_test = ?, provider = 'polar' WHERE id = ?", [url.slice(0, 700), /sandbox/i.test(link) ? 1 : 0, inv.id]);
  return url;
}

/**
 * บิลระบุยอดเอง (manual) — เช่น ค่าติดตั้ง ค่าบริการพิเศษ หรือยอดตกลงกันเอง
 * serviceId/paymentLink: บิลที่มาจากแคตตาล็อกบริการ — ถ้าบริการมีลิงก์ Polar ที่แปะไว้ ใช้ลิงก์นั้นแทนการสร้าง checkout ผ่าน API
 */
async function createManualInvoice(q, { operator, amount, title = "", note = "", dueDays = DUE_DAYS, serviceId = null, paymentLink = "" }, { apiReady = false, testMode = false } = {}) {
  const op = String(operator || "").trim().slice(0, 100);
  if (!op) throw new Error("Operator is required");
  const amt = money(amount);
  if (!(amt >= MIN_THB)) throw new Error(`Amount must be at least ฿${MIN_THB}`);
  const ym = new Date().toISOString().slice(0, 7);
  const invoice_no = await nextInvoiceNo(q, ym);
  const due = new Date(); due.setDate(due.getDate() + Number(dueDays || DUE_DAYS));
  await q(`INSERT INTO billing_invoices (invoice_no, operator, ym, kind, service_id, records, usage_thb, carried_thb, adjust_thb, amount_thb, status, title, note, due_at)
           VALUES (?,?,?,'manual',?,0,0,0,?,?,'open',?,?,?)`,
    [invoice_no, op, ym, serviceId ? Number(serviceId) : null, amt, amt, String(title || "").slice(0, 190), String(note || "").slice(0, 500), due.toISOString().slice(0, 10)]);
  const inv = (await q("SELECT * FROM billing_invoices WHERE invoice_no = ?", [invoice_no]))[0];
  let linkError = "";
  if (paymentLink) { try { await applyPaymentLink(q, inv, paymentLink); } catch (e) { linkError = e.message; } }
  else if (apiReady) { try { await createCheckoutForInvoice(q, inv, { testMode }); } catch (e) { linkError = e.message; } }
  return { ...(await q("SELECT * FROM billing_invoices WHERE id = ?", [inv.id]))[0], linkError };
}

/** แอดมินแก้ยอด/หมายเหตุ แล้วสร้างลิงก์ใหม่ */
async function adjustInvoice(q, id, { adjust_thb, note }, { apiReady, testMode } = {}) {
  const inv = (await q("SELECT * FROM billing_invoices WHERE id = ?", [id]))[0];
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "paid") throw new Error("This invoice is already paid and cannot be adjusted");
  const adj = money(adjust_thb);
  const amount = money(Number(inv.usage_thb) + Number(inv.carried_thb) + adj);
  const status = amount <= 0 ? "void" : amount < MIN_THB ? "carried" : "open";
  const amountChanged = Number(inv.amount_thb) !== amount;
  await q("UPDATE billing_invoices SET adjust_thb = ?, amount_thb = ?, status = ?, note = ?, checkout_url = IF(?, '', checkout_url), checkout_id = IF(?, '', checkout_id) WHERE id = ?",
    [adj, amount, status, String(note || "").slice(0, 500), amountChanged ? 1 : 0, amountChanged ? 1 : 0, id]);
  const fresh = (await q("SELECT * FROM billing_invoices WHERE id = ?", [id]))[0];
  if (status === "open" && apiReady && !fresh.checkout_url) await createCheckoutForInvoice(q, fresh, { testMode });
  return fresh;
}

async function regenerateLink(q, id, { testMode } = {}) {
  const inv = (await q("SELECT * FROM billing_invoices WHERE id = ?", [id]))[0];
  if (!inv) throw new Error("Invoice not found");
  if (inv.status !== "open") throw new Error("Payment links can only be created for unpaid invoices");
  const link = await serviceLink(q, inv);
  if (link) return applyPaymentLink(q, inv, link);
  return createCheckoutForInvoice(q, inv, { testMode });
}

/** ลิงก์ Polar ของบริการต้นทาง — ใช้ได้เฉพาะเมื่อยอดบิลยังเท่าราคาบริการ (ถ้าแอดมินปรับยอด ต้องสร้าง checkout ใหม่ผ่าน API) */
async function serviceLink(q, inv) {
  if (!inv.service_id) return "";
  const svc = (await q("SELECT price_thb, payment_link FROM service_catalog WHERE id = ?", [inv.service_id]))[0];
  return svc && svc.payment_link && money(svc.price_thb) === money(inv.amount_thb) ? svc.payment_link : "";
}

/** บิลบริการที่ยังไม่จ่ายของลูกค้าคนเดิม (สร้างภายใน 24 ชม.) — กดซื้อซ้ำจะใช้บิลเดิม ไม่สร้างบิลซ้อน */
async function findOpenServiceInvoice(q, operator, serviceId) {
  const rows = await q(`SELECT * FROM billing_invoices WHERE operator = ? AND service_id = ? AND status = 'open' AND checkout_url <> ''
                        AND issued_at > NOW() - INTERVAL 1 DAY ORDER BY id DESC LIMIT 1`, [operator, Number(serviceId)]);
  return rows[0] || null;
}

async function markPaidManual(q, id, note = "") {
  await q("UPDATE billing_invoices SET status = 'paid', paid_at = NOW(), paid_via = 'manual', note = CONCAT(note, IF(note = '', '', ' | '), ?) WHERE id = ? AND status <> 'paid'", [String(note || "Paid manually").slice(0, 200), id]);
}

async function voidInvoice(q, id, note = "") {
  await q("UPDATE billing_invoices SET status = 'void', checkout_url = '', note = CONCAT(note, IF(note = '', '', ' | '), ?) WHERE id = ? AND status <> 'paid'", [String(note || "Voided").slice(0, 200), id]);
}

/**
 * Polar webhook (order.paid / order.updated / order.refunded): ผูก order เข้ากับบิลผ่าน metadata.invoice_id
 * คืน true ถ้ามีผลกับบิล
 */
async function applyPolarOrder(q, type, order) {
  const md = (order && order.metadata) || {};
  let invoiceId = Number(md.invoice_id);
  // ลิงก์ชำระเงินที่แปะเอง (checkout link) ส่งเลขบิลมาเป็น reference_id แทน invoice_id
  if (!invoiceId && md.reference_id) {
    const r = await q("SELECT id FROM billing_invoices WHERE invoice_no = ? LIMIT 1", [String(md.reference_id).slice(0, 32)]);
    invoiceId = r[0] ? Number(r[0].id) : 0;
  }
  if (!invoiceId) return (type === "order.paid" || type === "order.updated") ? recordSubscriptionOrder(q, order) : false;
  const paid = order.paid === true || order.status === "paid";
  if ((type === "order.paid" || type === "order.created" || type === "order.updated") && paid) {
    // ผูก order เสมอ (แม้แอดมินจะมาร์ค paid ไว้ก่อน) เพื่อให้ลูกค้าเห็นลิงก์ใบเสร็จ
    await q("UPDATE billing_invoices SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), paid_via = 'polar', provider = 'polar', provider_order_id = ? WHERE id = ?", [String(order.id), invoiceId]);
    if (!order.is_invoice_generated) { try { await polar.generateOrderInvoice(order.id); } catch (e) { console.error("[polar invoice]", e.message); } }
    await storePolarReceipt(q, order.id);
    return true;
  }
  if (type === "order.refunded") {
    await q("UPDATE billing_invoices SET note = CONCAT(note, IF(note = '', '', ' | '), 'Refunded') WHERE id = ?", [invoiceId]);
    return true;
  }
  return false;
}

/** ดึง URL ใบเสร็จ/ใบแจ้งหนี้ของ order จาก Polar (ถ้าสร้างเสร็จแล้ว) เก็บลง billing_invoices.receipt_url */
async function storePolarReceipt(q, orderId) {
  try {
    const url = await polar.getOrderInvoice(orderId);
    if (url) { await q("UPDATE billing_invoices SET receipt_url = ? WHERE provider_order_id = ?", [String(url).slice(0, 700), String(orderId)]); return url; }
  } catch (e) { console.error("[polar receipt]", e.message); }
  return "";
}

/** เรียกจาก webhook order_created/refunded ของ Lemon Squeezy: ผูก order เข้ากับบิลผ่าน custom_data.invoice_id */
async function applyOrderWebhook(q, payload) {
  const custom = (payload.meta && payload.meta.custom_data) || {};
  const event = (payload.meta && payload.meta.event_name) || "";
  const a = (payload.data && payload.data.attributes) || {};
  const invoiceId = Number(custom.invoice_id);
  if (!invoiceId) return false;
  if (event === "order_created" && (a.status === "paid" || a.status === "pending")) {
    if (a.status !== "paid") return false;
    // ผูก order เสมอ (แม้แอดมินจะมาร์ค paid ไว้ก่อน) เพื่อให้ลูกค้าเห็นลิงก์ใบเสร็จ
    await q("UPDATE billing_invoices SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), paid_via = 'lemonsqueezy', ls_order_id = ? WHERE id = ?", [Number(payload.data.id), invoiceId]);
    return true;
  }
  if (event === "order_refunded") {
    await q("UPDATE billing_invoices SET note = CONCAT(note, IF(note = '', '', ' | '), 'Refunded') WHERE id = ?", [invoiceId]);
    return true;
  }
  return false;
}

// ---- ไฟล์แนบของบิล (ใบเสร็จ/ใบกำกับภาษีที่แอดมินอัปโหลด ลูกค้าดาวน์โหลดได้ในพอร์ทัล) ----
const ATTACH_KINDS = { receipt: "Receipt", tax_invoice: "Tax invoice", other: "Document" };
const ATTACH_MIME = /^(application\/pdf|image\/(png|jpe?g|webp))$/;
const ATTACH_MAX = 5 * 1024 * 1024;

async function addAttachment(q, invoiceId, file, kind = "receipt") {
  if (!file || !file.buffer || !file.size) throw new Error("Choose a file to upload");
  if (file.size > ATTACH_MAX) throw new Error("File is larger than 5 MB");
  if (!ATTACH_MIME.test(file.mimetype)) throw new Error("Only PDF, PNG, JPG or WebP files can be attached");
  const inv = (await q("SELECT id FROM billing_invoices WHERE id = ?", [invoiceId]))[0];
  if (!inv) throw new Error("Invoice not found");
  const name = String(file.originalname || "receipt").replace(/[^\w.\- ()\u0E00-\u0E7F]+/g, "_").slice(0, 190);
  await q("INSERT INTO billing_attachments (invoice_id, kind, filename, mime, size, data) VALUES (?,?,?,?,?,?)",
    [invoiceId, ATTACH_KINDS[kind] ? kind : "receipt", name, file.mimetype, file.size, file.buffer]);
}
async function listAttachments(q, invoiceIds) {
  if (!invoiceIds.length) return [];
  return q("SELECT id, invoice_id, kind, filename, mime, size, uploaded_at FROM billing_attachments WHERE invoice_id IN (?) ORDER BY id", [invoiceIds]);
}
async function getAttachment(q, id) {
  return (await q("SELECT * FROM billing_attachments WHERE id = ?", [Number(id)]))[0] || null;
}
async function deleteAttachment(q, id) {
  await q("DELETE FROM billing_attachments WHERE id = ?", [Number(id)]);
}
async function setReceiptUrl(q, id, url) {
  const s = String(url || "").trim();
  if (s && !/^https:\/\/\S+$/i.test(s)) throw new Error("Receipt link must start with https://");
  await q("UPDATE billing_invoices SET receipt_url = ? WHERE id = ?", [s.slice(0, 700), id]);
}

module.exports = { MIN_THB, DUE_DAYS, generateInvoices, createManualInvoice, adjustInvoice, regenerateLink, markPaidManual, voidInvoice, applyOrderWebhook, applyPolarOrder, storePolarReceipt, createCheckoutForInvoice, prevMonth,
  findOpenServiceInvoice, recordSubscriptionOrder, ATTACH_KINDS, ATTACH_MAX, addAttachment, listAttachments, getAttachment, deleteAttachment, setReceiptUrl };
