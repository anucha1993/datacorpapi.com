"use strict";
/**
 * ใบแจ้งหนี้รายเดือน — คำนวณยอดต่อลูกค้า (operator) จาก v_usage_monthly แล้วสร้างลิงก์ชำระเงิน
 * Lemon Squeezy (Single payment + custom_price = ยอดบิล) ลูกค้ากดจ่ายในพอร์ทัล webhook มาร์คชำระแล้ว
 */
const ls = require("./lemonsqueezy");

const MIN_THB = Number(process.env.INVOICE_MIN_THB || 17);     // ขั้นต่ำของ Lemon Squeezy ≈ ฿16.83
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

/** ยอดที่ยกมา = บิล 'carried' ของเดือนก่อนหน้าที่ยังไม่ถูกนำไปรวม (รวมทุกเดือนก่อนหน้า) */
async function carriedBalance(q, operator, ym) {
  const rows = await q("SELECT COALESCE(SUM(amount_thb),0) s FROM billing_invoices WHERE operator = ? AND status = 'carried' AND ym < ?", [operator, ym]);
  return money(rows[0] && rows[0].s);
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

/** สร้าง/อัปเดตลิงก์ชำระเงินของบิล (ต้องมี LS_API_KEY) */
async function createCheckoutForInvoice(q, inv, opts = {}) {
  const info = await customerInfo(q, inv.operator);
  const siteUrl = (process.env.SITE_URL || "").replace(/\/+$/, "");
  const label = inv.kind === "manual"
    ? `AI-Copilot — ${inv.title || "Invoice"} (${inv.invoice_no})`
    : `AI-Copilot usage fee for ${inv.ym} (${inv.invoice_no})`;
  const r = await ls.createCheckout({
    amountThb: inv.amount_thb,
    email: info.email, name: info.name, taxNumber: info.taxNumber, country: info.country, zip: info.zip,
    custom: { invoice_id: String(inv.id), invoice_no: inv.invoice_no, operator: inv.operator, ym: inv.ym },
    productName: label,
    productDescription: inv.kind === "manual" ? (inv.note || inv.title || "") : `${inv.records} records · usage ฿${inv.usage_thb}${Number(inv.carried_thb) ? ` · carried forward ฿${inv.carried_thb}` : ""}${Number(inv.adjust_thb) ? ` · adjustment ฿${inv.adjust_thb}` : ""}`,
    redirectUrl: siteUrl ? `${siteUrl}/portal/billing?paid=${inv.invoice_no}` : undefined,
    receiptButtonText: "Open customer portal",
    receiptLinkUrl: siteUrl ? `${siteUrl}/portal/login` : undefined,
    receiptNote: `Payment for invoice ${inv.invoice_no} (${inv.ym})`,
    testMode: opts.testMode,
  });
  await q("UPDATE billing_invoices SET checkout_id = ?, checkout_url = ?, checkout_test = ? WHERE id = ?", [r.id, r.url, r.test_mode ? 1 : 0, inv.id]);
  return r;
}

/**
 * ออกบิลของเดือน ym ให้ทุก operator ที่มีการใช้งาน (หรือมียอดยกมา)
 * - มีบิล paid/void แล้ว → ข้าม
 * - มีบิล open อยู่ → คำนวณยอดใหม่ (ถ้าเดือนยังไม่จบ ยอดอาจเปลี่ยน) และสร้างลิงก์ใหม่ถ้ายอดเปลี่ยน
 * คืน list ผลลัพธ์
 */
async function generateInvoices(q, ym, { only = null, apiReady = false, testMode = false, log = () => {} } = {}) {
  const usage = await q(`SELECT operator, SUM(billable_records) records, SUM(amount_thb) amount FROM v_usage_monthly WHERE ym = ? ${only ? "AND operator = ?" : ""} GROUP BY operator`, only ? [ym, only] : [ym]);
  // operator ที่ไม่มีการใช้งานเดือนนี้แต่มียอดยกมา
  const carriedOps = await q(`SELECT DISTINCT operator FROM billing_invoices WHERE status = 'carried' AND ym < ? ${only ? "AND operator = ?" : ""}`, only ? [ym, only] : [ym]);
  const ops = new Map();
  for (const u of usage) ops.set(u.operator, { records: Number(u.records || 0), usage: money(u.amount) });
  for (const c of carriedOps) if (!ops.has(c.operator)) ops.set(c.operator, { records: 0, usage: 0 });

  const results = [];
  for (const [operator, u] of ops) {
    if (!operator) continue;
    const res = { operator, ym, records: u.records, usage: u.usage, carried: 0, amount: 0, status: "", invoice_no: "", message: "" };
    try {
      const existing = (await q("SELECT * FROM billing_invoices WHERE operator = ? AND ym = ? AND kind = 'usage' LIMIT 1", [operator, ym]))[0];
      if (existing && (existing.status === "paid" || existing.status === "void")) {
        Object.assign(res, { status: existing.status, invoice_no: existing.invoice_no, amount: Number(existing.amount_thb), message: "Already exists (unchanged)" });
        results.push(res); continue;
      }
      const carried = existing ? Number(existing.carried_thb) : await carriedBalance(q, operator, ym);
      const adjust = existing ? Number(existing.adjust_thb) : 0;
      const amount = money(u.usage + carried + adjust);
      const status = amount <= 0 ? "void" : amount < MIN_THB ? "carried" : "open";
      Object.assign(res, { carried, amount, status });
      let inv;
      if (!existing) {
        const invoice_no = await nextInvoiceNo(q, ym);
        const due = new Date(); due.setDate(due.getDate() + DUE_DAYS);
        await q(`INSERT INTO billing_invoices (invoice_no, operator, ym, kind, records, usage_thb, carried_thb, adjust_thb, amount_thb, status, due_at)
                 VALUES (?,?,?,'usage',?,?,?,?,?,?,?)`, [invoice_no, operator, ym, u.records, u.usage, carried, adjust, amount, status, due.toISOString().slice(0, 10)]);
        // บิลที่ยกมา ถูกรวมแล้ว → ปิดเป็น void พร้อมหมายเหตุ
        if (carried > 0) await q("UPDATE billing_invoices SET status = 'void', note = CONCAT(note, ' → merged into ', ?) WHERE operator = ? AND status = 'carried' AND ym < ?", [invoice_no, operator, ym]);
        inv = (await q("SELECT * FROM billing_invoices WHERE invoice_no = ?", [invoice_no]))[0];
        res.message = "Invoice created";
      } else {
        const changed = Number(existing.amount_thb) !== amount || existing.records !== u.records || existing.status !== status;
        await q("UPDATE billing_invoices SET records = ?, usage_thb = ?, amount_thb = ?, status = ? WHERE id = ?", [u.records, u.usage, amount, status, existing.id]);
        inv = { ...existing, records: u.records, usage_thb: u.usage, amount_thb: amount, status };
        res.message = changed ? "Amount updated" : "Unchanged";
        if (!changed && inv.checkout_url) { res.invoice_no = inv.invoice_no; results.push(res); continue; }
      }
      res.invoice_no = inv.invoice_no;
      if (status === "open") {
        if (apiReady) {
          try { await createCheckoutForInvoice(q, inv, { testMode }); res.message += " + payment link"; }
          catch (e) { res.message += ` (payment link failed: ${e.message})`; }
        } else res.message += " (LS_API_KEY not set — no payment link)";
      } else if (status === "carried") res.message += ` (below ฿${MIN_THB} minimum — carried to next month)`;
      log(`[invoice] ${ym} ${operator} ${res.invoice_no} ฿${amount} ${status} — ${res.message}`);
    } catch (e) {
      res.message = "ERROR: " + e.message;
    }
    results.push(res);
  }
  return results;
}

/** บิลระบุยอดเอง (manual) — เช่น ค่าติดตั้ง ค่าบริการพิเศษ หรือยอดตกลงกันเอง */
async function createManualInvoice(q, { operator, amount, title = "", note = "", dueDays = DUE_DAYS }, { apiReady = false, testMode = false } = {}) {
  const op = String(operator || "").trim().slice(0, 100);
  if (!op) throw new Error("Operator is required");
  const amt = money(amount);
  if (!(amt >= MIN_THB)) throw new Error(`Amount must be at least ฿${MIN_THB}`);
  const ym = new Date().toISOString().slice(0, 7);
  const invoice_no = await nextInvoiceNo(q, ym);
  const due = new Date(); due.setDate(due.getDate() + Number(dueDays || DUE_DAYS));
  await q(`INSERT INTO billing_invoices (invoice_no, operator, ym, kind, records, usage_thb, carried_thb, adjust_thb, amount_thb, status, title, note, due_at)
           VALUES (?,?,?,'manual',0,0,0,?,?,'open',?,?,?)`,
    [invoice_no, op, ym, amt, amt, String(title || "").slice(0, 190), String(note || "").slice(0, 500), due.toISOString().slice(0, 10)]);
  const inv = (await q("SELECT * FROM billing_invoices WHERE invoice_no = ?", [invoice_no]))[0];
  let linkError = "";
  if (apiReady) { try { await createCheckoutForInvoice(q, inv, { testMode }); } catch (e) { linkError = e.message; } }
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
  return createCheckoutForInvoice(q, inv, { testMode });
}

async function markPaidManual(q, id, note = "") {
  await q("UPDATE billing_invoices SET status = 'paid', paid_at = NOW(), paid_via = 'manual', note = CONCAT(note, IF(note = '', '', ' | '), ?) WHERE id = ? AND status <> 'paid'", [String(note || "Paid manually").slice(0, 200), id]);
}

async function voidInvoice(q, id, note = "") {
  await q("UPDATE billing_invoices SET status = 'void', checkout_url = '', note = CONCAT(note, IF(note = '', '', ' | '), ?) WHERE id = ? AND status <> 'paid'", [String(note || "Voided").slice(0, 200), id]);
}

/** เรียกจาก webhook order_created/refunded: ผูก order เข้ากับบิลผ่าน custom_data.invoice_id */
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

module.exports = { MIN_THB, DUE_DAYS, generateInvoices, createManualInvoice, adjustInvoice, regenerateLink, markPaidManual, voidInvoice, applyOrderWebhook, createCheckoutForInvoice, prevMonth };
