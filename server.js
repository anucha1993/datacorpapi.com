/**
 * เว็บไซต์ + ระบบหลังบ้านของ DataCorp API
 *   /            หน้าเว็บสาธารณะ: บริการ ราคา นโยบาย ติดต่อ
 *   /portal      พอร์ทัลลูกค้า: ยอดการใช้งาน ใบแจ้งหนี้ ชำระเงินผ่าน Polar (หรือ Lemon Squeezy)
 *   /admin       หน้าหลังบ้าน (รหัสผ่าน): ยอดการใช้งาน ลูกค้า ใบแจ้งหนี้
 *   /webhooks/polar          รับเหตุการณ์คำสั่งซื้อจาก Polar (order.paid ...)
 *   /webhooks/lemonsqueezy   รับเหตุการณ์คำสั่งซื้อ/subscription จาก Lemon Squeezy (ถ้ายังใช้)
 *
 * รัน:  npm install && cp .env.example .env (แก้ค่า) && npm start
 */
"use strict";
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");
const multer = require("multer");
const mysql = require("mysql2/promise");
const ls = require("./lib/lemonsqueezy");
const billing = require("./lib/billing");
const { company } = require("./lib/company");
const portal = require("./lib/portal");
const invoices = require("./lib/invoices");
const payments = require("./lib/payments");
const services = require("./lib/services");
const polar = require("./lib/polar");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const LS_API_KEY = (process.env.LS_API_KEY || "").trim();
const LS_WEBHOOK_SECRET = (process.env.LS_WEBHOOK_SECRET || "").trim();
const LS_USAGE_ACTION = (process.env.LS_USAGE_ACTION || "set").trim() === "increment" ? "increment" : "set";
const LS_TEST_MODE = /^(1|true|yes)$/i.test(process.env.LS_TEST_MODE || "");
const POLAR_WEBHOOK_SECRET = (process.env.POLAR_WEBHOOK_SECRET || "").trim();
const payOpts = () => ({ apiReady: payments.info().ready, testMode: payments.info().testMode });
const STATUS_INV = { open: "Unpaid", paid: "Paid", void: "Void", carried: "Carried forward" };
const LS_USAGE_QUANTITY = (process.env.LS_USAGE_QUANTITY || "amount").trim() === "records" ? "records" : "amount";

// ไม่ปิดแอปถ้ายังไม่ได้ตั้งรหัส admin — หน้าเว็บสาธารณะต้องเปิดได้เสมอ แค่ปิดการ login หลังบ้านไว้
const ADMIN_DISABLED = !ADMIN_PASSWORD;
if (ADMIN_DISABLED) console.error("⚠ ADMIN_PASSWORD is not set in .env — /admin is disabled until it is set");
{
  const co = company();
  if (!co.isComplete) console.warn("⚠ Business details missing in .env (payment provider reviewers must see them on the site):", co.missing.join(", "));
  const pay = payments.info();
  console.log(`• payment provider: ${pay.name}${pay.testMode ? " (test/sandbox)" : ""}${pay.ready ? "" : " — " + pay.envApi + " not set"}`);
  if (!pay.webhookReady) console.warn(`⚠ ${pay.envSecret} is not set — ${pay.name} webhooks will be rejected`);
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || "ewp_usage",
  user: process.env.DB_USER || "ewp_web",
  password: process.env.DB_PASSWORD || "",
  ssl: /^(1|true|yes)$/i.test(process.env.DB_SSL || "") ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 5,
  charset: "utf8mb4",
  timezone: "+07:00",
  dateStrings: true,
});

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
/** สำหรับหน้าเว็บสาธารณะ — ถ้า DB ล่ม หน้าเว็บต้องยังเปิดได้ */
async function qSafe(sql, params = [], fallback = []) {
  try { return await q(sql, params); } catch (e) { console.error("[db]", e.code || e.message); return fallback; }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const MODE_LABELS = {
  etracking: "e-Tracking — application list", permit_report: "Permit application report",
  aliens: "Foreign worker list (account)", namelist_alien: "Renewal name list (NameList)",
  ticket: "Ticket ID check", receipts: "Receipts / BT.44 / BT.22 forms", results: "Result notice / application receipt", medical_cert: "Medical certificate download",
  bill_payment: "Payment slips", payment_receipts: "Full receipt set", bt30_ctn: "Acknowledgement / appointment slips",
  appointment: "Card appointment (address from receipt)", register: "Worker registration", inform: "Employer notification (BT.52)",
  bt30: "MoU permit renewal (BT.30)", bt44: "Employer change (BT.44)", booking_availability: "Appointment slot checker (real-time)",
};
const MODE_GROUP = {
  etracking: "report", permit_report: "report", aliens: "report", namelist_alien: "report", ticket: "report",
  receipts: "download", results: "download", medical_cert: "download", bill_payment: "download", payment_receipts: "download",
  bt30_ctn: "download", appointment: "download", register: "submit", inform: "submit", bt30: "submit",
  bt44: "submit", booking_availability: "booking",
};
const GROUP_LABELS = { report: "Reports", download: "Downloads", submit: "Submissions", booking: "Appointments" };
const STATUS_LABELS = { ok: "Success", cancelled: "Cancelled", error: "Error" };

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const validYm = (s) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(s || "") ? s : thisMonth());
const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
const fmtMoney = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtDur(sec) {
  sec = Number(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
async function monthsAvailable() {
  const rows = await q("SELECT DISTINCT DATE_FORMAT(started_at, '%Y-%m') ym FROM usage_runs ORDER BY ym DESC LIMIT 36");
  const set = new Set(rows.map(r => r.ym));
  set.add(thisMonth());
  return [...set].sort().reverse();
}
/** แพ็กเกจจาก plans.json + override checkout_url ด้วย env LS_CHECKOUT_URL_<KEY> */
function loadPlans() {
  let cfg = { plans: [] };
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "plans.json"), "utf8")); } catch (e) { console.error("[plans.json]", e.message); }
  for (const p of cfg.plans || []) {
    const envUrl = (process.env[`LS_CHECKOUT_URL_${String(p.key).toUpperCase()}`] || "").trim();
    if (envUrl) p.checkout_url = envUrl;
  }
  return cfg.plans || [];
}
/**
 * ข้อมูลสำหรับเอกสารใบแจ้งหนี้ (views/partials/invoice_doc.ejs): ผู้ซื้อ รายการ ไฟล์แนบ
 * บิลรายเดือนแตกรายการตามประเภทงาน (ถ้ายอดจาก view ยังตรงกับยอดในบิล) ไม่งั้นแสดงเป็นบรรทัดเดียว
 */
async function invoiceDoc(inv) {
  const [buyerRows, files] = await Promise.all([
    q("SELECT * FROM portal_users WHERE operator = ? LIMIT 1", [inv.operator]),
    invoices.listAttachments(q, [inv.id]),
  ]);
  let lines = [];
  if (inv.kind === "manual") {
    lines.push({ name: inv.title || "Service", desc: inv.note || "", qty: 1, unit: Number(inv.amount_thb), amount: Number(inv.amount_thb) });
  } else {
    const byMode = await q("SELECT mode_label, billable_records, unit_price, amount_thb FROM v_usage_monthly WHERE ym = ? AND operator = ? AND amount_thb <> 0 ORDER BY amount_thb DESC", [inv.ym, inv.operator]);
    const viewSum = byMode.reduce((s, r) => s + Number(r.amount_thb || 0), 0);
    if (byMode.length && Math.abs(viewSum - Number(inv.usage_thb)) < 0.01) {
      lines = byMode.map(r => ({ name: r.mode_label, desc: `Usage ${inv.ym}`, qty: Number(r.billable_records), unit: r.unit_price != null ? Number(r.unit_price) : null, amount: Number(r.amount_thb) }));
    } else if (Number(inv.usage_thb)) {
      lines.push({ name: `Usage for ${inv.ym}`, desc: `${fmtNum(inv.records)} billable records`, qty: 1, unit: Number(inv.usage_thb), amount: Number(inv.usage_thb) });
    }
    if (Number(inv.carried_thb)) lines.push({ name: "Balance carried forward", desc: "Previous months below the payment minimum", qty: 1, unit: Number(inv.carried_thb), amount: Number(inv.carried_thb) });
    if (Number(inv.adjust_thb)) lines.push({ name: "Adjustment", desc: inv.note || "", qty: 1, unit: Number(inv.adjust_thb), amount: Number(inv.adjust_thb) });
  }
  const today = new Date().toISOString().slice(0, 10);
  return { inv, buyer: buyerRows[0] || { operator: inv.operator }, lines, files, overdue: inv.status === "open" && !!inv.due_at && inv.due_at < today };
}
function sendAttachment(res, a) {
  res.setHeader("Content-Type", a.mime);
  res.setHeader("Content-Length", a.size);
  res.setHeader("Content-Disposition", `inline; filename="${a.filename.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.end(a.data);
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: invoices.ATTACH_MAX, files: 1 } });

/** rate-limit ง่าย ๆ ในหน่วยความจำ: key → [timestamps] */
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  return arr.length <= limit;
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.locals.fmtNum = fmtNum;
app.locals.fmtMoney = fmtMoney;
app.locals.fmtDur = fmtDur;
app.locals.MODE_LABELS = MODE_LABELS;
app.locals.GROUP_LABELS = GROUP_LABELS;
app.locals.STATUS_LABELS = STATUS_LABELS;
app.locals.STATUS_INV = STATUS_INV;
app.locals.MIN_THB = invoices.MIN_THB;
app.locals.DUE_DAYS = invoices.DUE_DAYS;

// ---- Webhook (ต้องอ่าน raw body ก่อน body parser อื่น) ----
app.post("/webhooks/lemonsqueezy", express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
  if (!LS_WEBHOOK_SECRET) return res.status(503).json({ error: "webhook secret not configured" });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!ls.verifySignature(raw, req.get("X-Signature"), LS_WEBHOOK_SECRET)) return res.status(401).json({ error: "invalid signature" });
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: "invalid json" }); }
  try {
    const r = await billing.handleWebhook(q, raw, payload);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error("[webhook]", e);
    res.status(500).json({ error: "processing failed" }); // LS จะส่งซ้ำให้
  }
});

app.post("/webhooks/polar", express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
  if (!POLAR_WEBHOOK_SECRET) return res.status(503).json({ error: "webhook secret not configured" });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!polar.verifyWebhook(raw, req.headers, POLAR_WEBHOOK_SECRET)) return res.status(401).json({ error: "invalid signature" });
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: "invalid json" }); }
  try {
    const r = await billing.handlePolarWebhook(q, raw, payload);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error("[polar webhook]", e);
    res.status(500).json({ error: "processing failed" }); // Polar จะส่งซ้ำให้
  }
});

app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.use(cookieSession({ name: "ewpusage", secret: SESSION_SECRET, httpOnly: true, sameSite: "lax", maxAge: 12 * 60 * 60 * 1000 }));

// =========================== หน้าเว็บสาธารณะ ===========================
const site = (req, res, view, extra = {}) => res.render(`site/${view}`, { co: company(), path: req.path, ...extra });

app.get("/", async (req, res) => site(req, res, "home", { title: "Home", plans: loadPlans() }));
app.get("/pricing", async (req, res) => {
  const prices = (await qSafe("SELECT * FROM usage_prices ORDER BY mode")).map(p => ({ ...p, mode_group: MODE_GROUP[p.mode] || "" }));
  site(req, res, "pricing", { title: "Pricing", plans: loadPlans(), prices });
});
app.get("/terms", (req, res) => site(req, res, "terms", { title: "Terms of Service" }));
app.get("/privacy", (req, res) => site(req, res, "privacy", { title: "Privacy Policy" }));
app.get("/refund", (req, res) => site(req, res, "refund", { title: "Refund & Cancellation Policy" }));
app.get("/thanks", (req, res) => site(req, res, "thanks", { title: "Thank you" }));
app.get("/contact", (req, res) => site(req, res, "contact", { title: "Contact", sent: req.query.sent === "1", error: null, form: {} }));
app.post("/contact", async (req, res) => {
  const form = { name: String(req.body.name || "").trim().slice(0, 190), email: String(req.body.email || "").trim().slice(0, 190),
                 company: String(req.body.company || "").trim().slice(0, 190), message: String(req.body.message || "").trim().slice(0, 4000) };
  if (String(req.body.website || "")) return res.redirect("/contact?sent=1"); // honeypot
  if (!hit("contact:" + req.ip, 5, 60 * 60 * 1000)) return site(req, res, "contact", { title: "Contact", sent: false, error: "Too many messages. Please try again later.", form });
  if (!form.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email) || !form.message)
    return site(req, res, "contact", { title: "Contact", sent: false, error: "Please fill in your name, a valid email and a message.", form });
  try {
    await q("INSERT INTO contact_messages (name, email, company, message, ip) VALUES (?,?,?,?,?)", [form.name, form.email, form.company, form.message, String(req.ip).slice(0, 64)]);
  } catch (e) {
    console.error("[contact]", e.code || e.message);
    return site(req, res, "contact", { title: "Contact", sent: false, error: `We could not save your message. Please email ${company().COMPANY_EMAIL || "us"} directly.`, form });
  }
  res.redirect("/contact?sent=1");
});
/** ส่งต่อไปหน้า checkout ของ Lemon Squeezy พร้อม prefill อีเมล + custom data (operator/company) */
app.get("/checkout/:plan", (req, res) => {
  const plan = loadPlans().find(p => p.key === req.params.plan);
  if (!plan || !plan.checkout_url) return res.status(404).render("site/error", { co: company(), path: req.path, title: "Plan not found", message: "The selected plan does not exist or is not available yet." });
  const email = String(req.query.email || "").trim().slice(0, 190);
  const operator = String(req.query.operator || "").trim().slice(0, 100);
  const co = String(req.query.company || "").trim().slice(0, 190);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !operator) return res.redirect("/pricing#plan-" + plan.key);
  res.redirect(ls.buildCheckoutUrl(plan.checkout_url, { email, operator, company: co }));
});
/** โปรแกรมเรียกตรวจ serial ก่อนทำงาน: POST JSON { serial, install_id, machine, windows_user, app_version } */
app.post("/api/license/verify", express.json({ limit: "8kb" }), async (req, res) => {
  if (!hit("lic:" + req.ip, 60, 10 * 60 * 1000)) return res.status(429).json({ ok: false, error: "rate_limited", message: "Too many requests" });
  try {
    const b = req.body || {};
    const r = await portal.verifySerial(q, { serial: b.serial, install_id: b.install_id, machine: b.machine, windows_user: b.windows_user, app_version: b.app_version, ip: String(req.ip).slice(0, 64) });
    res.status(r.ok ? 200 : 403).json(r);
  } catch (e) { console.error("[license]", e.message); res.status(500).json({ ok: false, error: "server", message: "Server error" }); }
});
app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /admin\nDisallow: /login\nDisallow: /portal\nAllow: /\n"));
app.get("/api/health", async (req, res) => {
  const pay = payments.info();
  const cfg = { admin_password: !ADMIN_DISABLED, company_complete: company().isComplete, payment_provider: pay.key, payment_api: pay.ready, payment_test_mode: pay.testMode, webhook_secret: pay.webhookReady, node: process.version };
  try { await q("SELECT 1"); res.json({ ok: true, ...cfg }); } catch (e) { res.status(500).json({ ok: false, error: e.code || "db", ...cfg }); }
});

// =========================== Customer Portal (/portal) ===========================
const requirePortal = async (req, res, next) => {
  const op = req.session && req.session.portal;
  if (!op) return res.redirect("/portal/login");
  try {
    const rows = await q("SELECT * FROM portal_users WHERE operator = ? AND is_active = 1 LIMIT 1", [op]);
    if (!rows[0]) { req.session.portal = null; return res.redirect("/portal/login"); }
    req.portalUser = rows[0];
    if (!req.portalUser.serial_no) req.portalUser.serial_no = await portal.ensureSerial(q, req.portalUser.operator);
    next();
  } catch (e) { next(e); }
};
app.get("/portal/login", (req, res) => {
  if (req.session && req.session.portal) return res.redirect("/portal");
  res.render("portal/login", { co: company(), error: null, operator: "" });
});
app.post("/portal/login", async (req, res, next) => {
  const operator = String(req.body.operator || "").trim();
  try {
    if (!hit("plogin:" + req.ip, 8, 10 * 60 * 1000)) return res.status(429).render("portal/login", { co: company(), error: "Too many attempts. Please wait 10 minutes and try again.", operator });
    const u = await portal.authenticate(q, operator, req.body.password || "");
    if (!u) return res.status(401).render("portal/login", { co: company(), error: "Incorrect operator name or password.", operator });
    req.session.portal = u.operator;
    res.redirect(u.must_change ? "/portal/password" : "/portal");
  } catch (e) { next(e); }
});
app.post("/portal/logout", (req, res) => { if (req.session) req.session.portal = null; res.redirect("/portal/login"); });

app.get("/portal", requirePortal, async (req, res, next) => {
  try {
    const u = req.portalUser, op = u.operator, ym = validYm(req.query.ym);
    const [byMode, runs, trend, subs, reps, monthsRows] = await Promise.all([
      q("SELECT v.*, v.unit_price AS price_per_record FROM v_usage_monthly v WHERE v.ym = ? AND v.operator = ? ORDER BY v.amount_thb DESC", [ym, op]),
      q("SELECT * FROM usage_runs WHERE DATE_FORMAT(started_at,'%Y-%m') = ? AND operator = ? ORDER BY started_at DESC LIMIT 200", [ym, op]),
      q("SELECT ym, runs, billable_records, amount_thb FROM v_usage_monthly_by_operator WHERE operator = ? ORDER BY ym DESC LIMIT 12", [op]),
      q("SELECT invoice_no, ym, amount_thb, due_at FROM billing_invoices WHERE operator = ? AND status = 'open' ORDER BY ym", [op]),
      q("SELECT ym, quantity, amount_thb, ok, sent_at FROM billing_usage_reports WHERE operator = ? ORDER BY sent_at DESC", [op]),
      q("SELECT DISTINCT DATE_FORMAT(started_at,'%Y-%m') ym FROM usage_runs WHERE operator = ? ORDER BY ym DESC LIMIT 24", [op]),
    ]);
    const months = [...new Set([thisMonth(), ...monthsRows.map(r => r.ym)])].sort().reverse();
    const reports = {}; for (const r of reps) if (!reports[r.ym]) reports[r.ym] = r;
    const sum = (k) => byMode.reduce((a, r) => a + Number(r[k] || 0), 0);
    const totals = { amount: sum("amount_thb"), records: sum("billable_records"), runs: sum("runs"), ok: sum("runs_ok"), cancelled: sum("runs_cancelled"), error: sum("runs_error"), total_sec: sum("total_sec") };
    res.render("portal/dashboard", { co: company(), title: "Usage", user: u, ym, months, byMode, runs, trend, openInvoices: subs, reports, totals });
  } catch (e) { next(e); }
});
app.get("/portal/export.csv", requirePortal, async (req, res, next) => {
  try {
    const ym = validYm(req.query.ym);
    const rows = await q("SELECT * FROM v_usage_monthly WHERE ym = ? AND operator = ? ORDER BY amount_thb DESC", [ym, req.portalUser.operator]);
    const head = ["Month", "Operator", "Task type", "Runs", "Success", "Cancelled", "Error", "Billable records", "Total seconds", "Amount (THB)"];
    const lines = [head.join(",")].concat(rows.map(r => [r.ym, r.operator, r.mode_label, r.runs, r.runs_ok, r.runs_cancelled, r.runs_error, r.billable_records, r.total_sec, r.amount_thb].map(csvCell).join(",")));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="usage_${req.portalUser.operator}_${ym}.csv"`);
    res.send("\uFEFF" + lines.join("\r\n"));
  } catch (e) { next(e); }
});
/** หน้าการชำระเงินของลูกค้า: ใบแจ้งหนี้รายเดือน + ปุ่มจ่ายผ่านผู้ให้บริการรับชำระเงิน */
app.get("/portal/billing", requirePortal, async (req, res, next) => {
  try {
    const u = req.portalUser, op = u.operator;
    const [inv, cur] = await Promise.all([
      q(`SELECT i.*, COALESCE(NULLIF(i.receipt_url, ''), o.receipt_url, '') AS receipt_url FROM billing_invoices i LEFT JOIN billing_orders o ON o.order_id = i.ls_order_id WHERE i.operator = ? ORDER BY i.ym DESC, i.id DESC LIMIT 36`, [op]),
      q("SELECT COALESCE(SUM(amount_thb),0) amt FROM v_usage_monthly WHERE ym = ? AND operator = ?", [thisMonth(), op]),
    ]);
    const sum = { open: 0, open_n: 0, paid: 0 };
    for (const r of inv) { if (r.status === "open") { sum.open += Number(r.amount_thb); sum.open_n++; } if (r.status === "paid") sum.paid += Number(r.amount_thb); }
    const profileComplete = !!(u.company_name && u.address && u.zip && (u.billing_email || u.email));
    const files = {};
    for (const a of await invoices.listAttachments(q, inv.map(r => r.id))) (files[a.invoice_id] ||= []).push(a);
    res.render("portal/billing", { co: company(), title: "Billing", pageTitle: "Invoices & payments", user: u, invoices: inv, files, sum, currentEstimate: Number(cur[0].amt || 0),
      today: new Date().toISOString().slice(0, 10), paidNo: String(req.query.paid || "").slice(0, 32) || null, profileComplete });
  } catch (e) { next(e); }
});
app.get("/portal/profile", requirePortal, (req, res) => res.render("portal/profile", { co: company(), title: "Billing details", user: req.portalUser, error: null, saved: req.query.saved === "1" }));
app.post("/portal/profile", requirePortal, async (req, res, next) => {
  try {
    const f = (k, n) => String(req.body[k] || "").trim().slice(0, n);
    const data = { company_name: f("company_name", 190), tax_id: f("tax_id", 32).replace(/[^0-9-]/g, ""), address: f("address", 500), zip: f("zip", 16), billing_email: f("billing_email", 190), display_name: f("display_name", 190) };
    if (!data.company_name || !data.address || !/^\d{5}$/.test(data.zip) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.billing_email))
      return res.status(400).render("portal/profile", { co: company(), title: "Billing details", user: { ...req.portalUser, ...data }, error: "Please enter a company name, address, 5-digit postal code and a valid email.", saved: false });
    await q("UPDATE portal_users SET company_name = ?, tax_id = ?, address = ?, zip = ?, billing_email = ?, display_name = ? WHERE id = ?",
      [data.company_name, data.tax_id, data.address, data.zip, data.billing_email, data.display_name || req.portalUser.display_name, req.portalUser.id]);
    res.redirect("/portal/profile?saved=1");
  } catch (e) { next(e); }
});
app.get("/portal/password", requirePortal, (req, res) => res.render("portal/password", { co: company(), title: "Change password", user: req.portalUser, error: null, saved: req.query.saved === "1" }));
app.post("/portal/password", requirePortal, async (req, res, next) => {
  try {
    const u = req.portalUser, { current = "", next: nx = "", confirm = "" } = req.body;
    const render = (error) => res.status(400).render("portal/password", { co: company(), title: "Change password", user: u, error, saved: false });
    if (!portal.verifyPassword(current, u.password_hash)) return render("Current password is incorrect.");
    const err = portal.validatePassword(nx); if (err) return render(err);
    if (nx !== confirm) return render("New passwords do not match.");
    await q("UPDATE portal_users SET password_hash = ?, must_change = 0 WHERE id = ?", [portal.hashPassword(nx), u.id]);
    res.redirect("/portal/password?saved=1");
  } catch (e) { next(e); }
});

/** ใบแจ้งหนี้ฉบับเต็ม (พิมพ์/บันทึก PDF ได้) — ลูกค้าเห็นเฉพาะของตัวเอง */
app.get("/portal/invoices/:no", requirePortal, async (req, res, next) => {
  try {
    const inv = (await q("SELECT * FROM billing_invoices WHERE invoice_no = ? AND operator = ? LIMIT 1", [String(req.params.no).slice(0, 32), req.portalUser.operator]))[0];
    if (!inv) return res.status(404).render("portal/error", { co: company(), user: req.portalUser, title: "Invoice not found", message: "This invoice does not exist or belongs to another account.", detail: "" });
    res.render("portal/invoice", { co: company(), title: "Billing", pageTitle: inv.invoice_no, user: req.portalUser, ...(await invoiceDoc(inv)) });
  } catch (e) { next(e); }
});
app.get("/portal/attachments/:id", requirePortal, async (req, res, next) => {
  try {
    const a = await invoices.getAttachment(q, req.params.id);
    const owner = a && (await q("SELECT 1 FROM billing_invoices WHERE id = ? AND operator = ?", [a.invoice_id, req.portalUser.operator]))[0];
    if (!owner) return res.status(404).render("portal/error", { co: company(), user: req.portalUser, title: "File not found", message: "This file does not exist.", detail: "" });
    sendAttachment(res, a);
  } catch (e) { next(e); }
});

/** หน้าร้านค้าบริการของลูกค้า: เลือกบริการ → ตรวจสอบคำสั่งซื้อ → ไปหน้าชำระเงินของ Polar */
const renderServices = async (req, res, error = null, status = 200) =>
  res.status(status).render("portal/services", { co: company(), title: "Services", user: req.portalUser, rows: await services.listActive(q), error });
app.get("/portal/services", requirePortal, async (req, res, next) => {
  try { await renderServices(req, res); } catch (e) { next(e); }
});
app.get("/portal/services/:id", requirePortal, async (req, res, next) => {
  try {
    const svc = await services.get(q, req.params.id);
    if (!svc || !svc.is_active) return renderServices(req, res, "This service is no longer available.", 404);
    const u = req.portalUser;
    res.render("portal/checkout", { co: company(), title: "Services", pageTitle: "Review order", user: u, svc, error: null,
      profileComplete: !!(u.company_name && u.address && u.zip && (u.billing_email || u.email)) });
  } catch (e) { next(e); }
});
app.post("/portal/services/:id/buy", requirePortal, async (req, res, next) => {
  const u = req.portalUser;
  let svc = null;
  const back = (error, status = 400) => res.status(status).render("portal/checkout", { co: company(), title: "Services", pageTitle: "Review order", user: u, svc, error,
    profileComplete: !!(u.company_name && u.address && u.zip && (u.billing_email || u.email)) });
  try {
    svc = await services.get(q, req.params.id);
    if (!svc || !svc.is_active) return renderServices(req, res, "This service is no longer available.", 404);
    if (!req.body.agree) return back("Please accept the Terms of Service and Refund Policy to continue.");
    if (!hit("buy:" + u.operator, 5, 10 * 60 * 1000)) return back("Too many purchase attempts. Please wait a few minutes and try again.", 429);
    // กดซื้อซ้ำภายใน 24 ชม. → ใช้บิลเดิมที่ยังไม่จ่าย ไม่สร้างบิลซ้อน
    const existing = await invoices.findOpenServiceInvoice(q, u.operator, svc.id);
    if (existing) return res.redirect(existing.checkout_url);
    const inv = await invoices.createManualInvoice(q, { operator: u.operator, amount: svc.price_thb, title: svc.name, note: svc.description, serviceId: svc.id, paymentLink: svc.payment_link }, payOpts());
    if (inv.checkout_url) return res.redirect(inv.checkout_url);
    res.redirect("/portal/invoices/" + encodeURIComponent(inv.invoice_no));
  } catch (e) {
    if (e.code && String(e.code).startsWith("ER_")) return next(e);
    try { back(e.message); } catch (e2) { next(e2); }
  }
});

// =========================== auth ===========================
app.get("/login", (req, res) => res.render("login", { error: ADMIN_DISABLED ? "ADMIN_PASSWORD is not set in the server .env file" : null, title: "Sign in" }));
app.post("/login", (req, res) => {
  if (ADMIN_DISABLED) return res.status(503).render("login", { error: "ADMIN_PASSWORD is not set in the server .env file", title: "Sign in" });
  if (!hit("login:" + req.ip, 5, 60 * 1000)) return res.status(429).render("login", { error: "Too many attempts. Wait 1 minute and try again.", title: "Sign in" });
  if (safeEq(req.body.password || "", ADMIN_PASSWORD)) { req.session.auth = true; return res.redirect("/admin"); }
  res.status(401).render("login", { error: "Incorrect password.", title: "Sign in" });
});
app.post("/logout", (req, res) => { req.session = null; res.redirect("/login"); });

const requireAuth = (req, res, next) => {
  if (req.session && req.session.auth) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  res.redirect("/login");
};

// =========================== admin ===========================
const admin = express.Router();
admin.use(requireAuth);

admin.get("/", async (req, res, next) => {
  try {
    const ym = validYm(req.query.ym);
    const [byOp, byMode, totals, months, daily] = await Promise.all([
      q("SELECT * FROM v_usage_monthly_by_operator WHERE ym = ? ORDER BY amount_thb DESC, operator", [ym]),
      q(`SELECT mode, mode_label, mode_group, SUM(runs) runs, SUM(billable_records) billable_records, SUM(total_sec) total_sec, SUM(amount_thb) amount_thb
         FROM v_usage_monthly WHERE ym = ? GROUP BY mode, mode_label, mode_group ORDER BY amount_thb DESC`, [ym]),
      q(`SELECT COUNT(*) runs, SUM(status='ok') ok, SUM(status='cancelled') cancelled, SUM(status='error') error,
                COUNT(DISTINCT operator) operators, COUNT(DISTINCT install_id) installs, SUM(duration_sec) total_sec
         FROM usage_runs WHERE DATE_FORMAT(started_at,'%Y-%m') = ?`, [ym]),
      monthsAvailable(),
      q("SELECT DATE(started_at) d, COUNT(*) runs, SUM(record_count) records FROM usage_runs WHERE DATE_FORMAT(started_at,'%Y-%m') = ? GROUP BY d ORDER BY d", [ym]),
    ]);
    const amount = byOp.reduce((s, r) => s + Number(r.amount_thb || 0), 0);
    const records = byOp.reduce((s, r) => s + Number(r.billable_records || 0), 0);
    res.render("dashboard", { title: "Overview", ym, months, byOp, byMode, daily, totals: { ...totals[0], amount, records },
      maxDaily: Math.max(1, ...daily.map(d => Number(d.runs))), coMissing: company().missing });
  } catch (e) { next(e); }
});

admin.get("/operator/:name", async (req, res, next) => {
  try {
    const ym = validYm(req.query.ym), name = req.params.name;
    const [byMode, runs, months, trend] = await Promise.all([
      q("SELECT * FROM v_usage_monthly WHERE ym = ? AND operator = ? ORDER BY amount_thb DESC", [ym, name]),
      q("SELECT * FROM usage_runs WHERE DATE_FORMAT(started_at,'%Y-%m') = ? AND operator = ? ORDER BY started_at DESC LIMIT 200", [ym, name]),
      monthsAvailable(),
      q("SELECT ym, runs, billable_records, amount_thb FROM v_usage_monthly_by_operator WHERE operator = ? ORDER BY ym DESC LIMIT 12", [name]),
    ]);
    const [devices, acct] = await Promise.all([
      q("SELECT * FROM license_devices WHERE operator = ? ORDER BY last_seen DESC", [name]),
      q("SELECT serial_no, display_name, is_active FROM portal_users WHERE operator = ?", [name]),
    ]);
    res.render("operator", { title: `Operator: ${name}`, ym, months, name, byMode, runs, trend, devices, acct: acct[0] || null });
  } catch (e) { next(e); }
});

admin.get("/runs", async (req, res, next) => {
  try {
    const ym = validYm(req.query.ym);
    const { operator = "", mode = "", status = "" } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1), per = 50;
    const where = ["DATE_FORMAT(started_at,'%Y-%m') = ?"], params = [ym];
    if (operator) { where.push("operator = ?"); params.push(operator); }
    if (mode) { where.push("mode = ?"); params.push(mode); }
    if (status && STATUS_LABELS[status]) { where.push("status = ?"); params.push(status); }
    const W = where.join(" AND ");
    const [cnt, rows, ops, months] = await Promise.all([
      q(`SELECT COUNT(*) n FROM usage_runs WHERE ${W}`, params),
      q(`SELECT * FROM usage_runs WHERE ${W} ORDER BY started_at DESC LIMIT ? OFFSET ?`, [...params, per, (page - 1) * per]),
      q("SELECT DISTINCT operator FROM usage_runs ORDER BY operator"),
      monthsAvailable(),
    ]);
    res.render("runs", { title: "Runs", ym, months, rows, ops, filters: { operator, mode, status }, page, pages: Math.max(1, Math.ceil(cnt[0].n / per)), total: cnt[0].n });
  } catch (e) { next(e); }
});

admin.get("/prices", async (req, res, next) => {
  try {
    const prices = await q("SELECT * FROM usage_prices ORDER BY mode");
    const known = new Set(prices.map(p => p.mode));
    res.render("prices", { title: "Prices", prices, missing: Object.keys(MODE_LABELS).filter(m => !known.has(m)), saved: req.query.saved === "1" });
  } catch (e) { next(e); }
});
admin.post("/prices", async (req, res, next) => {
  try {
    const modes = [].concat(req.body.mode || []), perRec = [].concat(req.body.price_per_record || []);
    const perRun = [].concat(req.body.price_per_run || []), labels = [].concat(req.body.mode_label || []);
    for (let i = 0; i < modes.length; i++) {
      const m = String(modes[i]).slice(0, 40);
      if (!/^[a-z0-9_]+$/i.test(m)) continue;
      await q(`INSERT INTO usage_prices (mode, mode_label, price_per_record, price_per_run) VALUES (?,?,?,?)
               ON DUPLICATE KEY UPDATE mode_label=VALUES(mode_label), price_per_record=VALUES(price_per_record), price_per_run=VALUES(price_per_run)`,
        [m, String(labels[i] || MODE_LABELS[m] || m).slice(0, 120), Number(perRec[i]) || 0, Number(perRun[i]) || 0]);
    }
    res.redirect("/admin/prices?saved=1");
  } catch (e) { next(e); }
});

admin.get("/installs", async (req, res, next) => {
  try { res.render("installs", { title: "Installs", rows: await q("SELECT * FROM v_usage_installs ORDER BY last_seen DESC") }); }
  catch (e) { next(e); }
});

admin.get("/export.csv", async (req, res, next) => {
  try {
    const ym = validYm(req.query.ym);
    const rows = await q("SELECT * FROM v_usage_monthly WHERE ym = ? ORDER BY operator, amount_thb DESC", [ym]);
    const head = ["Month", "Operator", "Mode", "Mode label", "Group", "Runs", "Success", "Cancelled", "Error", "Billable records", "Total seconds", "Amount (THB)"];
    const lines = [head.join(",")].concat(rows.map(r => [r.ym, r.operator, r.mode, r.mode_label, GROUP_LABELS[r.mode_group] || r.mode_group, r.runs, r.runs_ok,
      r.runs_cancelled, r.runs_error, r.billable_records, r.total_sec, r.amount_thb].map(csvCell).join(",")));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="usage_${ym}.csv"`);
    res.send("﻿" + lines.join("\r\n"));
  } catch (e) { next(e); }
});

// ---- ลูกค้า / Lemon Squeezy ----
async function renderBilling(req, res, next, extra = {}) {
  try {
    const [subs, orders, events, operators, months] = await Promise.all([
      q(`SELECT s.*, c.operator, c.company,
                (SELECT ym FROM billing_usage_reports r WHERE r.subscription_id = s.subscription_id ORDER BY sent_at DESC LIMIT 1) last_report_ym,
                (SELECT quantity FROM billing_usage_reports r WHERE r.subscription_id = s.subscription_id ORDER BY sent_at DESC LIMIT 1) last_report_qty,
                (SELECT ok FROM billing_usage_reports r WHERE r.subscription_id = s.subscription_id ORDER BY sent_at DESC LIMIT 1) last_report_ok
         FROM billing_subscriptions s LEFT JOIN billing_customers c ON c.customer_id = s.customer_id
         ORDER BY FIELD(s.status,'active','on_trial','past_due','paused','cancelled','unpaid','expired'), s.updated_at DESC`),
      q("SELECT * FROM billing_orders ORDER BY ordered_at DESC LIMIT 100"),
      q("SELECT id, event_name, object_type, object_id, received_at FROM billing_events ORDER BY id DESC LIMIT 30"),
      q("SELECT DISTINCT operator FROM usage_runs WHERE operator <> '' ORDER BY operator"),
      monthsAvailable(),
    ]);
    const pay = payments.info();
    res.render("billing", { title: "Payments", subs, orders, events, operators, months, ym: validYm(req.query.ym || req.body?.ym),
      pay, lsReady: pay.ready, webhookReady: pay.webhookReady, siteUrl: company().SITE_URL || "", report: null, ...extra });
  } catch (e) { next(e); }
}
admin.get("/billing", (req, res, next) => renderBilling(req, res, next));
admin.post("/billing/operator", async (req, res, next) => {
  try {
    const id = Number(req.body.customer_id), operator = String(req.body.operator || "").trim().slice(0, 100);
    if (id) await q("UPDATE billing_customers SET operator = ? WHERE customer_id = ?", [operator, id]);
    res.redirect("/admin/billing");
  } catch (e) { next(e); }
});

// ---- ใบแจ้งหนี้ ----
const INV_FILTERS = { open: "i.status = 'open'", overdue: "i.status = 'open' AND i.due_at < CURDATE()", paid: "i.status = 'paid'", void: "i.status = 'void'", carried: "i.status = 'carried'", manual: "i.kind = 'manual'" };
async function renderInvoices(req, res, next, extra = {}) {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const all = src.ym === "all", ym = all ? "all" : validYm(src.ym);
    const status = INV_FILTERS[src.status] ? src.status : "", operator = String(src.operator || "").trim().slice(0, 100);
    const where = [], params = [];
    if (!all) { where.push("i.ym = ?"); params.push(ym); }
    if (status) where.push(INV_FILTERS[status]);
    if (operator) { where.push("i.operator = ?"); params.push(operator); }
    const [rows, months, carried, svcRows] = await Promise.all([
      q(`SELECT i.*, p.company_name, (SELECT COUNT(*) FROM billing_attachments a WHERE a.invoice_id = i.id) files
         FROM billing_invoices i LEFT JOIN portal_users p ON p.operator = i.operator
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY FIELD(i.status,'open','carried','paid','void'), i.issued_at DESC, i.id DESC LIMIT 500`, params),
      monthsAvailable(),
      q("SELECT COALESCE(SUM(amount_thb),0) s FROM billing_invoices WHERE status = 'carried'"),
      services.listAll(q),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const opsRows = await q("SELECT operator FROM portal_users WHERE is_active = 1 UNION SELECT DISTINCT operator FROM usage_runs WHERE operator <> '' ORDER BY operator");
    const operators = [...new Set(opsRows.map(r => r.operator))];
    const sum = { open: 0, open_n: 0, paid: 0, paid_n: 0, overdue_n: 0, carried: Number(carried[0].s || 0) };
    for (const r of rows) {
      if (r.status === "open") { sum.open += Number(r.amount_thb); sum.open_n++; if (r.due_at && r.due_at < today) sum.overdue_n++; }
      if (r.status === "paid") { sum.paid += Number(r.amount_thb); sum.paid_n++; }
    }
    const pay = payments.info();
    res.render("invoices", { title: "Invoices", ym, months, rows, sum, today, operators, filters: { status, operator }, services: svcRows,
      pay, lsReady: pay.ready, testMode: pay.testMode, msg: req.query.msg || null, error: req.query.error || null, report: null, ...extra });
  } catch (e) { next(e); }
}
admin.get("/invoices", (req, res, next) => renderInvoices(req, res, next));
admin.post("/invoices/generate", async (req, res, next) => {
  try {
    const ym = validYm(req.body.ym);
    const report = await invoices.generateInvoices(q, ym, { ...payOpts(), log: console.log });
    req.query.ym = ym;
    renderInvoices(req, res, next, { report });
  } catch (e) { next(e); }
});
admin.post("/invoices/manual", async (req, res, next) => {
  try {
    // เลือกบริการจากแคตตาล็อกได้ — ยอด/ชื่อ/รายละเอียดว่าง = ใช้ของบริการ, ยอดตรงราคาบริการ = ใช้ลิงก์ Polar ที่แปะไว้
    const svc = req.body.service_id ? await services.get(q, req.body.service_id) : null;
    const amount = String(req.body.amount || "").trim() || (svc ? svc.price_thb : "");
    const inv = await invoices.createManualInvoice(q, {
      operator: req.body.operator, amount, title: req.body.title || (svc ? svc.name : ""), note: req.body.note || (svc ? svc.description : ""), dueDays: req.body.due_days,
      serviceId: svc ? svc.id : null, paymentLink: svc && Number(svc.price_thb) === Number(amount) ? svc.payment_link : "",
    }, payOpts());
    const msg = `Created ${inv.invoice_no} for ${inv.operator}: ฿${inv.amount_thb}` + (inv.linkError ? ` (payment link failed: ${inv.linkError})` : inv.checkout_url ? " with payment link" : "");
    res.redirect(`/admin/invoices/${inv.id}?msg=` + encodeURIComponent(msg));
  } catch (e) {
    if (e.code && String(e.code).startsWith("ER_")) return next(e);
    req.query.ym = validYm(req.query.ym);
    renderInvoices(req, res, next, { error: e.message });
  }
});
/** หลังทำรายการ: กลับหน้ารายละเอียดบิล (ถ้ามาจากหน้านั้น) หรือรายการบิลของเดือน */
const invRedirect = (req, res, id, msg, isError = false) => {
  if (req.body && req.body.back === "detail") return res.redirect(`/admin/invoices/${id}` + (msg ? (isError ? "?error=" : "?msg=") + encodeURIComponent(msg) : ""));
  return q("SELECT ym FROM billing_invoices WHERE id = ?", [id]).then(r => res.redirect("/admin/invoices?ym=" + (r[0] ? r[0].ym : thisMonth()) + (msg ? (isError ? "&error=" : "&msg=") + encodeURIComponent(msg) : "")));
};
const invFail = (req, res, next, id) => (e) => {
  if (e.code && String(e.code).startsWith("ER_")) return next(e);
  if (req.body && req.body.back === "detail") return invRedirect(req, res, id, e.message, true);
  renderInvoices(req, res, next, { error: e.message });
};
admin.get("/invoices/:id(\\d+)", async (req, res, next) => {
  try {
    const inv = (await q("SELECT * FROM billing_invoices WHERE id = ?", [Number(req.params.id)]))[0];
    if (!inv) return res.status(404).render("error", { title: "Invoice not found", message: "No invoice with this id.", detail: "" });
    res.render("invoice", { title: "Invoices", co: company(), pay: payments.info(), siteUrl: company().SITE_URL || "", ATTACH_KINDS: invoices.ATTACH_KINDS,
      msg: req.query.msg || null, error: req.query.error || null, ...(await invoiceDoc(inv)) });
  } catch (e) { next(e); }
});
admin.post("/invoices/:id/adjust", async (req, res, next) => {
  const id = Number(req.params.id);
  try { const inv = await invoices.adjustInvoice(q, id, { adjust_thb: req.body.adjust_thb, note: req.body.note }, payOpts()); invRedirect(req, res, id, `${inv.invoice_no} adjusted to ฿${inv.amount_thb}`); }
  catch (e) { invFail(req, res, next, id)(e); }
});
admin.post("/invoices/:id/link", async (req, res, next) => {
  const id = Number(req.params.id);
  try { await invoices.regenerateLink(q, id, { testMode: payOpts().testMode }); invRedirect(req, res, id, "Payment link created"); }
  catch (e) { invFail(req, res, next, id)(e); }
});
admin.post("/invoices/:id/paid", async (req, res, next) => {
  try { await invoices.markPaidManual(q, Number(req.params.id), String(req.body.note || "").trim() || "Marked paid by admin"); invRedirect(req, res, Number(req.params.id), "Marked as paid"); } catch (e) { next(e); }
});
admin.post("/invoices/:id/void", async (req, res, next) => {
  try { await invoices.voidInvoice(q, Number(req.params.id), "Voided by admin"); invRedirect(req, res, Number(req.params.id), "Invoice voided"); } catch (e) { next(e); }
});
admin.post("/invoices/:id/receipt-url", async (req, res, next) => {
  const id = Number(req.params.id);
  try { await invoices.setReceiptUrl(q, id, req.body.receipt_url); invRedirect(req, res, id, "Receipt link saved"); }
  catch (e) { invFail(req, res, next, id)(e); }
});
/** แนบไฟล์ใบเสร็จ/ใบกำกับภาษี (PDF/รูป ≤ 5 MB) — ลูกค้าดาวน์โหลดได้ในพอร์ทัล, ติ๊ก mark_paid เพื่อปิดบิลที่รับเงินช่องทางอื่น */
admin.post("/invoices/:id/attachments", (req, res, next) => {
  const id = Number(req.params.id);
  upload.single("file")(req, res, async (err) => {
    req.body = { ...(req.body || {}), back: "detail" };
    if (err) return invRedirect(req, res, id, err.code === "LIMIT_FILE_SIZE" ? "File is larger than 5 MB" : err.message, true);
    try {
      await invoices.addAttachment(q, id, req.file, req.body.kind);
      if (req.body.mark_paid) await invoices.markPaidManual(q, id, "Paid — receipt attached by admin");
      invRedirect(req, res, id, "File attached — the customer can download it from the portal");
    } catch (e) { invFail(req, res, next, id)(e); }
  });
});
admin.get("/attachments/:id", async (req, res, next) => {
  try {
    const a = await invoices.getAttachment(q, req.params.id);
    if (!a) return res.status(404).render("error", { title: "File not found", message: "This attachment no longer exists.", detail: "" });
    sendAttachment(res, a);
  } catch (e) { next(e); }
});
admin.post("/attachments/:id/delete", async (req, res, next) => {
  try {
    const a = await invoices.getAttachment(q, req.params.id);
    if (!a) return res.redirect("/admin/invoices");
    await invoices.deleteAttachment(q, a.id);
    req.body.back = "detail";
    invRedirect(req, res, a.invoice_id, "Attachment removed");
  } catch (e) { next(e); }
});

// ---- ขายบริการ (แสดงในพอร์ทัลลูกค้า ให้กดซื้อ/จ่ายเองได้) ----
admin.get("/services", async (req, res, next) => {
  try {
    const rows = await services.listAll(q);
    const editing = req.query.edit ? rows.find(r => r.id === Number(req.query.edit)) : null;
    res.render("services", { title: "Services", rows, editing, pay: payments.info(), msg: req.query.msg || null, error: null });
  } catch (e) { next(e); }
});
admin.post("/services", async (req, res, next) => {
  try {
    await services.create(q, { name: req.body.name, description: req.body.description, price_thb: req.body.price_thb, payment_link: req.body.payment_link, sort_order: req.body.sort_order, minThb: invoices.MIN_THB });
    res.redirect("/admin/services?msg=" + encodeURIComponent("Service added"));
  } catch (e) {
    if (e.code && String(e.code).startsWith("ER_")) return next(e);
    try { res.status(400).render("services", { title: "Services", rows: await services.listAll(q), editing: null, pay: payments.info(), msg: null, error: e.message }); }
    catch (e2) { next(e2); }
  }
});
admin.post("/services/:id/update", async (req, res, next) => {
  try {
    await services.update(q, Number(req.params.id), { name: req.body.name, description: req.body.description, price_thb: req.body.price_thb, payment_link: req.body.payment_link, sort_order: req.body.sort_order, minThb: invoices.MIN_THB });
    res.redirect("/admin/services?msg=" + encodeURIComponent("Service updated"));
  } catch (e) {
    if (e.code && String(e.code).startsWith("ER_")) return next(e);
    try {
      const rows = await services.listAll(q);
      res.status(400).render("services", { title: "Services", rows, editing: rows.find(r => r.id === Number(req.params.id)), pay: payments.info(), msg: null, error: e.message });
    } catch (e2) { next(e2); }
  }
});
admin.post("/services/:id/toggle", async (req, res, next) => {
  try { await services.toggle(q, Number(req.params.id)); res.redirect("/admin/services"); } catch (e) { next(e); }
});
admin.post("/services/:id/delete", async (req, res, next) => {
  try { await services.remove(q, Number(req.params.id)); res.redirect("/admin/services?msg=" + encodeURIComponent("Service deleted")); } catch (e) { next(e); }
});

// ---- บัญชีลูกค้า Customer Portal ----
async function renderPortalUsers(req, res, next, extra = {}) {
  try {
    const [rows, ops1, ops2] = await Promise.all([
      q("SELECT p.id, p.operator, p.serial_no, p.display_name, p.email, p.is_active, p.must_change, p.last_login_at, p.last_verified_at, (SELECT COUNT(*) FROM license_devices d WHERE d.operator = p.operator) devices FROM portal_users p ORDER BY p.operator"),
      q("SELECT DISTINCT operator FROM usage_runs WHERE operator <> ''"),
      q("SELECT DISTINCT operator FROM billing_customers WHERE operator <> ''"),
    ]);
    const operators = [...new Set([...ops1, ...ops2].map(r => r.operator))].sort();
    res.render("portal_users", { title: "Customer accounts", rows, operators, siteUrl: company().SITE_URL || "", msg: req.query.msg || null, error: null, ...extra });
  } catch (e) { next(e); }
}
admin.get("/portal-users", (req, res, next) => renderPortalUsers(req, res, next));
admin.post("/portal-users", async (req, res, next) => {
  try {
    const op = await portal.createUser(q, { operator: req.body.operator, password: req.body.password, display_name: req.body.display_name, email: req.body.email, must_change: req.body.must_change ? 1 : 0 });
    res.redirect("/admin/portal-users?msg=" + encodeURIComponent("Account '" + op + "' saved"));
  } catch (e) {
    if (e.code && String(e.code).startsWith("ER_")) return next(e);
    renderPortalUsers(req, res, next, { error: e.message });
  }
});
admin.post("/portal-users/:id/serial", async (req, res, next) => {
  try { const sn = await portal.regenerateSerial(q, Number(req.params.id)); res.redirect("/admin/portal-users?msg=" + encodeURIComponent("New serial issued: " + sn + " (the old one no longer works)")); }
  catch (e) { next(e); }
});
admin.post("/portal-users/:id/toggle", async (req, res, next) => {
  try { await q("UPDATE portal_users SET is_active = 1 - is_active WHERE id = ?", [Number(req.params.id)]); res.redirect("/admin/portal-users"); }
  catch (e) { next(e); }
});

// ---- ราคาเฉพาะลูกค้า ----
admin.get("/customers/:operator/prices", async (req, res, next) => {
  try {
    const operator = String(req.params.operator).slice(0, 100);
    const rows = await q(`SELECT p.mode, p.mode_label, p.price_per_record, p.price_per_run, c.price_per_record c_record, c.price_per_run c_run
                          FROM usage_prices p LEFT JOIN usage_prices_customer c ON c.mode = p.mode AND c.operator = ? ORDER BY p.mode`, [operator]);
    res.render("customer_prices", { title: "Customer prices", operator, rows, saved: req.query.saved === "1" });
  } catch (e) { next(e); }
});
admin.post("/customers/:operator/prices", async (req, res, next) => {
  try {
    const operator = String(req.params.operator).slice(0, 100);
    if (req.body.reset) {
      await q("DELETE FROM usage_prices_customer WHERE operator = ?", [operator]);
      return res.redirect(`/admin/customers/${encodeURIComponent(operator)}/prices?saved=1`);
    }
    const modes = [].concat(req.body.mode || []), rec = [].concat(req.body.price_per_record || []), run = [].concat(req.body.price_per_run || []);
    for (let i = 0; i < modes.length; i++) {
      const m = String(modes[i]).slice(0, 40);
      if (!/^[a-z0-9_]+$/i.test(m)) continue;
      const r = String(rec[i] ?? "").trim(), u = String(run[i] ?? "").trim();
      if (r === "" && u === "") { await q("DELETE FROM usage_prices_customer WHERE operator = ? AND mode = ?", [operator, m]); continue; }
      await q(`INSERT INTO usage_prices_customer (operator, mode, price_per_record, price_per_run) VALUES (?,?,?,?)
               ON DUPLICATE KEY UPDATE price_per_record = VALUES(price_per_record), price_per_run = VALUES(price_per_run)`,
        [operator, m, r === "" ? null : Number(r), u === "" ? null : Number(u)]);
    }
    res.redirect(`/admin/customers/${encodeURIComponent(operator)}/prices?saved=1`);
  } catch (e) { next(e); }
});

// ---- ข้อความติดต่อ ----
admin.get("/messages", async (req, res, next) => {
  try { res.render("messages", { title: "Messages", rows: await q("SELECT * FROM contact_messages ORDER BY is_read, created_at DESC LIMIT 300") }); }
  catch (e) { next(e); }
});
admin.post("/messages/:id/read", async (req, res, next) => {
  try { await q("UPDATE contact_messages SET is_read = 1 WHERE id = ?", [Number(req.params.id)]); res.redirect("/admin/messages"); }
  catch (e) { next(e); }
});

app.use("/admin", admin);

// ---- JSON API (ต้อง login) ----
app.get("/api/summary", requireAuth, async (req, res, next) => {
  try { const ym = validYm(req.query.ym); res.json({ ym, operators: await q("SELECT * FROM v_usage_monthly_by_operator WHERE ym = ? ORDER BY operator", [ym]) }); }
  catch (e) { next(e); }
});

// ---- errors ----
const errView = (req) => req.path.startsWith("/portal") ? "portal/error" : (req.path.startsWith("/admin") || req.path.startsWith("/api")) ? "error" : "site/error";
app.use((req, res) => {
  res.status(404).render(errView(req), { user: req.portalUser || null, co: company(), path: req.path, title: "Page not found", message: "The page you requested does not exist.", detail: req.path });
});
app.use((err, req, res, _next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ ok: false, error: "invalid_json", message: "Request body must be valid JSON" });
  console.error(err);
  const dbDown = ["ECONNREFUSED", "ETIMEDOUT", "ER_ACCESS_DENIED_ERROR", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST", "ER_NO_SUCH_TABLE"].includes(err.code);
  const view = errView(req), adminView = view === "error";
  res.status(500).render(view, {
    co: company(), path: req.path, title: "Something went wrong", user: req.portalUser || null,
    message: !adminView ? "We couldn't complete your request. Please try again in a few minutes — if it keeps happening, contact support."
      : dbDown ? "Database connection failed — check DB_* in .env, the database user's privileges, and that the sql/*.sql files were applied." : "An internal error occurred.",
    detail: !adminView ? "" : `${err.code || ""} ${err.sqlMessage || err.message || ""}`.trim(),
  });
});

app.listen(PORT, () => console.log(`✓ web http://localhost:${PORT}  (admin: /admin)`));
