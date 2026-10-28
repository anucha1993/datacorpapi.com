/**
 * เว็บไซต์ + แพลตฟอร์มขาย API Key / License Key ของ DataCorp API (แบบ GitHub Copilot)
 *   /            หน้าเว็บสาธารณะ: บริการ ราคา นโยบาย ติดต่อ
 *   /portal      พอร์ทัลลูกค้า: แพ็กเกจ โควตา API key / license key ใบแจ้งหนี้ ชำระเงินผ่าน Polar
 *   /admin       หน้าหลังบ้าน (รหัสผ่าน): สินค้า/แพ็กเกจ subscription ลูกค้า ใบแจ้งหนี้
 *   /api/v1/*    API ของแพลตฟอร์ม: authorize + นับโควตา (backend ของบริการเรียก), ตรวจ license (โปรแกรมเรียก)
 *   /api/license/verify      ตรวจ SN ของบัญชี (โปรแกรมเดิมยังใช้)
 *   /webhooks/polar          รับเหตุการณ์ order/subscription จาก Polar
 *   /webhooks/lemonsqueezy   รับเหตุการณ์คำสั่งซื้อจาก Lemon Squeezy (ถ้ายังใช้)
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
const platform = require("./lib/platform");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const LS_WEBHOOK_SECRET = (process.env.LS_WEBHOOK_SECRET || "").trim();
const POLAR_WEBHOOK_SECRET = (process.env.POLAR_WEBHOOK_SECRET || "").trim();
const payOpts = () => ({ apiReady: payments.info().ready, testMode: payments.info().testMode });
const STATUS_INV = { open: "Unpaid", paid: "Paid", void: "Void", carried: "Carried forward" };

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
  connectionLimit: 10,
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
function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const validYm = (s) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(s || "") ? s : thisMonth());
const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
const fmtMoney = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ราคาต่อหน่วย (อาจมีทศนิยม 4 ตำแหน่ง เช่น ฿0.0025 ต่อ token) */
const fmtUnit = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtDate = (s) => (s ? String(s).slice(0, 10) : "—");
function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
/** เดือนที่มีใบแจ้งหนี้ (สำหรับตัวเลือกเดือนในหน้าใบแจ้งหนี้) */
async function invoiceMonths() {
  const rows = await q("SELECT DISTINCT ym FROM billing_invoices ORDER BY ym DESC LIMIT 36");
  return [...new Set([thisMonth(), ...rows.map(r => r.ym)])].sort().reverse();
}
/** บริการแบบโปรเจกต์/ที่ปรึกษา จาก plans.json (แสดงใต้แพ็กเกจในหน้า Pricing) */
function loadPlans() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "plans.json"), "utf8")).plans || []; }
  catch (e) { console.error("[plans.json]", e.message); return []; }
}
const profileComplete = (u) => !!(u.company_name && u.address && u.zip && (u.billing_email || u.email));
const siteUrl = () => company().SITE_URL || "";

/**
 * ข้อมูลสำหรับเอกสารใบแจ้งหนี้ (views/partials/invoice_doc.ejs): ผู้ซื้อ รายการ ไฟล์แนบ
 */
async function invoiceDoc(inv) {
  const [buyerRows, files] = await Promise.all([
    q("SELECT * FROM portal_users WHERE operator = ? LIMIT 1", [inv.operator]),
    invoices.listAttachments(q, [inv.id]),
  ]);
  const lines = [];
  if (inv.kind === "manual" || inv.kind === "subscription") {
    lines.push({ name: inv.title || "Service", desc: inv.note || "", qty: 1, unit: Number(inv.amount_thb), amount: Number(inv.amount_thb) });
  } else {
    if (Number(inv.usage_thb)) {
      const qty = Number(inv.records) || 0;
      lines.push({ name: inv.title || `Usage for ${inv.ym}`, desc: inv.note || "", qty: qty || 1,
        unit: qty ? Number(inv.usage_thb) / qty : Number(inv.usage_thb), amount: Number(inv.usage_thb), unitPrecise: !!qty });
    }
    if (Number(inv.carried_thb)) lines.push({ name: "Balance carried forward", desc: "Previous months below the payment minimum", qty: 1, unit: Number(inv.carried_thb), amount: Number(inv.carried_thb) });
    if (Number(inv.adjust_thb)) lines.push({ name: "Adjustment", desc: "", qty: 1, unit: Number(inv.adjust_thb), amount: Number(inv.adjust_thb) });
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
const isDbError = (e) => e && e.code && String(e.code).startsWith("ER_");

/** rate-limit ง่าย ๆ ในหน่วยความจำ: key → [timestamps] */
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  return arr.length <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 3600000) buckets.delete(k); }, 600000).unref();

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
Object.assign(app.locals, {
  fmtNum, fmtMoney, fmtUnit, fmtDate, STATUS_INV, MIN_THB: invoices.MIN_THB, DUE_DAYS: invoices.DUE_DAYS,
  BILLING_LABELS: platform.BILLING_LABELS, SUB_STATUS: platform.SUB_STATUS,
});

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

// =========================== Platform API (/api/v1) ===========================
// JSON เสมอ (รวม error) — ใช้จาก backend ของบริการ และโปรแกรมของลูกค้า
const api = express.Router();
api.use(express.json({ limit: "16kb" }));
const bearer = (req) => String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
const send = (res, r) => res.status(r.status || (r.ok ? 200 : 400)).json(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "status")));

/**
 * POST /api/v1/authorize   (backend ของบริการเรียก)
 *   Authorization: Bearer <service secret ของสินค้า>
 *   { "key": "dca_sk_…", "units": 1, "dry_run": false }
 * → 200 { ok, customer, plan, quota } | 401 invalid_key | 402 payment_required | 403 inactive | 429 quota_exceeded/rate_limited
 */
api.post("/authorize", async (req, res, next) => {
  try {
    const product = await platform.productBySecret(q, bearer(req));
    if (!product) return res.status(401).json({ ok: false, error: "invalid_service_secret", message: "Missing or wrong service secret" });
    if (!product.is_active) return res.status(403).json({ ok: false, error: "product_disabled", message: "This product is disabled" });
    const b = req.body || {};
    send(res, await platform.authorize(q, product, b.key || b.api_key, { units: b.units ?? 1, dryRun: !!b.dry_run }));
  } catch (e) { next(e); }
});
/** GET /api/v1/usage   (ลูกค้าเรียกด้วย API key ของตัวเอง) → แพ็กเกจ + โควตาเดือนนี้ */
api.get("/usage", async (req, res, next) => {
  try {
    if (!hit("usage:" + req.ip, 120, 60 * 1000)) return res.status(429).json({ ok: false, error: "rate_limited", message: "Too many requests" });
    send(res, await platform.keyStatus(q, bearer(req)));
  } catch (e) { next(e); }
});
/**
 * POST /api/v1/license/verify   (โปรแกรมของลูกค้าเรียก)
 *   { "license_key": "DCL-…", "product": "slug", "device_id": "…", "device_name": "…", "app_version": "…" }
 */
api.post("/license/verify", async (req, res, next) => {
  try {
    if (!hit("lic2:" + req.ip, 60, 10 * 60 * 1000)) return res.status(429).json({ ok: false, error: "rate_limited", message: "Too many requests" });
    const b = req.body || {};
    send(res, await platform.verifyLicense(q, { license_key: b.license_key || b.key, product: String(b.product || ""), device_id: b.device_id, device_name: b.device_name, app_version: b.app_version, ip: String(req.ip).slice(0, 64) }));
  } catch (e) { next(e); }
});
api.use((req, res) => res.status(404).json({ ok: false, error: "not_found", message: "Unknown API endpoint" }));
// eslint-disable-next-line no-unused-vars
api.use((err, req, res, _next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ ok: false, error: "invalid_json", message: "Request body must be valid JSON" });
  console.error("[api]", err);
  res.status(500).json({ ok: false, error: "server", message: "Server error" });
});
app.use("/api/v1", api);

app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.use(cookieSession({ name: "ewpusage", secret: SESSION_SECRET, httpOnly: true, sameSite: "lax", maxAge: 12 * 60 * 60 * 1000 }));

// =========================== หน้าเว็บสาธารณะ ===========================
const site = (req, res, view, extra = {}) => res.render(`site/${view}`, { co: company(), path: req.path, ...extra });
const publicCatalog = async () => {
  try { return (await platform.listProducts(q, { activeOnly: true })).filter(p => p.plans.length); }
  catch (e) { console.error("[catalog]", e.code || e.message); return []; }
};

app.get("/", async (req, res) => site(req, res, "home", { title: "Home", plans: loadPlans(), products: await publicCatalog() }));
app.get("/pricing", async (req, res) => site(req, res, "pricing", { title: "Pricing", plans: loadPlans(), products: await publicCatalog() }));
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
/** ตรวจ SN ของบัญชี (โปรแกรมรุ่นเดิมเรียกก่อนทำงาน): POST JSON { serial, install_id, machine, windows_user, app_version } */
app.post("/api/license/verify", express.json({ limit: "8kb" }), async (req, res) => {
  if (!hit("lic:" + req.ip, 60, 10 * 60 * 1000)) return res.status(429).json({ ok: false, error: "rate_limited", message: "Too many requests" });
  try {
    const b = req.body || {};
    const r = await portal.verifySerial(q, { serial: b.serial, install_id: b.install_id, machine: b.machine, windows_user: b.windows_user, app_version: b.app_version, ip: String(req.ip).slice(0, 64) });
    res.status(r.ok ? 200 : 403).json(r);
  } catch (e) { console.error("[license]", e.message); res.status(500).json({ ok: false, error: "server", message: "Server error" }); }
});
app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /admin\nDisallow: /login\nDisallow: /portal\nDisallow: /api\nAllow: /\n"));
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
const pview = (req, res, view, data = {}, status = 200) => res.status(status).render(`portal/${view}`, { co: company(), user: req.portalUser, ...data });
const pnotFound = (req, res, what = "Page") => pview(req, res, "error", { title: `${what} not found`, message: `This ${what.toLowerCase()} does not exist or belongs to another account.`, detail: "" }, 404);

app.get("/portal/login", (req, res) => {
  if (req.session && req.session.portal) return res.redirect("/portal");
  res.render("portal/login", { co: company(), error: null, operator: "" });
});
app.post("/portal/login", async (req, res, next) => {
  const operator = String(req.body.operator || "").trim();
  try {
    if (!hit("plogin:" + req.ip, 8, 10 * 60 * 1000)) return res.status(429).render("portal/login", { co: company(), error: "Too many attempts. Please wait 10 minutes and try again.", operator });
    const u = await portal.authenticate(q, operator, req.body.password || "");
    if (!u) return res.status(401).render("portal/login", { co: company(), error: "Incorrect username or password.", operator });
    req.session.portal = u.operator;
    res.redirect(u.must_change ? "/portal/password" : "/portal");
  } catch (e) { next(e); }
});
app.post("/portal/logout", (req, res) => { if (req.session) req.session.portal = null; res.redirect("/portal/login"); });

/** หน้าแรก: แพ็กเกจที่ใช้อยู่ + โควตาเดือนนี้ (แบบ Copilot) + ยอดค้างชำระ */
app.get("/portal", requirePortal, async (req, res, next) => {
  try {
    const op = req.portalUser.operator;
    // checkout ที่ไม่จ่ายภายใน 1 วัน → หมดอายุ (ไม่รกหน้าลูกค้า)
    await q("UPDATE subscriptions SET status = 'expired' WHERE operator = ? AND status = 'pending' AND created_at < NOW() - INTERVAL 1 DAY", [op]);
    const [subs, openInvoices] = await Promise.all([
      platform.listSubscriptions(q, op),
      q("SELECT invoice_no, ym, title, amount_thb, due_at FROM billing_invoices WHERE operator = ? AND status = 'open' ORDER BY due_at, id", [op]),
    ]);
    pview(req, res, "dashboard", { title: "Overview", subs, openInvoices, ym: thisMonth() });
  } catch (e) { next(e); }
});

/** แค็ตตาล็อกแพ็กเกจ */
app.get("/portal/plans", requirePortal, async (req, res, next) => {
  try {
    const [products, subs] = await Promise.all([platform.listProducts(q, { activeOnly: true }), platform.listSubscriptions(q, req.portalUser.operator)]);
    const current = {};
    for (const s of subs) if (s.status === "active" || s.status === "past_due") current[s.product_id] = s;
    pview(req, res, "plans", { title: "Plans", products: products.filter(p => p.plans.length), current, error: req.query.error || null });
  } catch (e) { next(e); }
});
const renderPlanCheckout = async (req, res, plan, error = null, status = 200) => {
  const existing = await platform.activeForProduct(q, req.portalUser.operator, plan.product_id);
  const existingSub = existing ? await platform.getSubscription(q, existing.id) : null;
  pview(req, res, "subscribe", { title: "Plans", pageTitle: "Review plan", plan, existing: existingSub, error, profileComplete: profileComplete(req.portalUser), pay: payments.info() }, status);
};
app.get("/portal/plans/:id", requirePortal, async (req, res, next) => {
  try {
    const plan = await platform.getPlan(q, req.params.id);
    if (!plan || !plan.is_active || !plan.product_active) return pnotFound(req, res, "Plan");
    await renderPlanCheckout(req, res, plan);
  } catch (e) { next(e); }
});
/**
 * สมัคร/เปลี่ยนแพ็กเกจ
 *  - ฟรี / จ่ายตามใช้งาน → เปิดใช้ทันที (ค่าใช้งานออกบิลรายเดือน)
 *  - รายเดือน/รายปี → สร้าง subscription รอชำระ แล้วไป checkout ของ Polar (webhook เปิดใช้งาน)
 *  - มีแพ็กเกจที่จ่ายผ่าน Polar อยู่แล้ว → เปลี่ยนแพ็กเกจผ่าน Polar API (คิดเงินตามสัดส่วนโดย Polar)
 */
app.post("/portal/plans/:id/subscribe", requirePortal, async (req, res, next) => {
  const u = req.portalUser;
  let plan = null;
  try {
    plan = await platform.getPlan(q, req.params.id);
    if (!plan || !plan.is_active || !plan.product_active) return pnotFound(req, res, "Plan");
    if (!req.body.agree) return renderPlanCheckout(req, res, plan, "Please accept the Terms of Service and Refund Policy to continue.", 400);
    if (!hit("sub:" + u.operator, 6, 10 * 60 * 1000)) return renderPlanCheckout(req, res, plan, "Too many attempts. Please wait a few minutes and try again.", 429);

    const existing = await platform.activeForProduct(q, u.operator, plan.product_id);
    if (existing && existing.plan_id === plan.id) return res.redirect(`/portal/subscriptions/${existing.id}?msg=` + encodeURIComponent("You are already on this plan."));
    const paidPolar = existing && existing.source === "polar" && existing.provider_sub_id;
    const isPaid = plan.billing !== "usage" && Number(plan.price_thb) > 0;

    if (!isPaid) {
      if (paidPolar) return renderPlanCheckout(req, res, plan, "To move to this plan, cancel your current paid plan first — it stays active until the end of the period you paid for.", 400);
      const id = await platform.createSubscription(q, u.operator, plan);
      await platform.supersedeOthers(q, u.operator, plan.product_id, id);
      return res.redirect(`/portal/subscriptions/${id}?welcome=1`);
    }
    if (payments.info().key !== "polar" || !payments.info().ready) return renderPlanCheckout(req, res, plan, "Online subscriptions are not available right now. Please contact support.", 503);
    if (paidPolar) {
      await polar.api("PATCH", `/v1/subscriptions/${encodeURIComponent(existing.provider_sub_id)}`, { product_id: plan.polar_product_id });
      return res.redirect(`/portal/subscriptions/${existing.id}?msg=` + encodeURIComponent(`Switching to ${plan.name}. ${polar.isSandbox() ? "(test mode) " : ""}The change appears here within a minute.`));
    }
    // ใช้แถว pending เดิมของแพ็กเกจเดียวกัน (กดซ้ำ) ไม่งั้นสร้างใหม่
    const pend = (await q("SELECT id FROM subscriptions WHERE operator = ? AND plan_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [u.operator, plan.id]))[0];
    const subId = pend ? pend.id : await platform.createSubscription(q, u.operator, plan);
    const base = siteUrl();
    const co = await q("SELECT * FROM portal_users WHERE operator = ?", [u.operator]);
    const cu = co[0] || u;
    const r = await polar.createSubscriptionCheckout({
      productId: plan.polar_product_id, email: cu.billing_email || cu.email || "", name: cu.company_name || cu.display_name || cu.operator,
      customerKey: u.operator, taxNumber: cu.tax_id || "", metadata: { subscription_ref: subId, operator: u.operator, plan_id: plan.id },
      successUrl: base ? `${base}/portal/subscriptions/${subId}?welcome=1` : undefined,
    });
    res.redirect(r.url);
  } catch (e) {
    if (isDbError(e)) return next(e);
    console.error("[subscribe]", e.message);
    try { await renderPlanCheckout(req, res, plan, "We could not start the checkout: " + e.message, 400); } catch (e2) { next(e2); }
  }
});

/** จัดการ subscription: โควตา, key, เครื่องที่ผูก license, ยกเลิก/ต่ออายุ */
async function renderSubscription(req, res, sub, extra = {}) {
  const [keys, history, inv] = await Promise.all([
    platform.listKeys(q, sub.id),
    platform.usageHistory(q, sub.id, 12),
    q("SELECT invoice_no, kind, title, amount_thb, status, issued_at FROM billing_invoices WHERE subscription_id = ? ORDER BY id DESC LIMIT 12", [sub.id]),
  ]);
  pview(req, res, "subscription", { title: "Overview", pageTitle: sub.product_name, sub, keys, history, invoices: inv, newKey: null,
    msg: req.query.msg || null, error: req.query.error || null, welcome: req.query.welcome === "1", base: siteUrl(), ...extra });
}
const loadMySub = async (req, res) => {
  const sub = await platform.getSubscription(q, req.params.id, req.portalUser.operator);
  if (!sub) { pnotFound(req, res, "Subscription"); return null; }
  return sub;
};
const subRedirect = (res, id, msg, isError = false) => res.redirect(`/portal/subscriptions/${id}?${isError ? "error" : "msg"}=` + encodeURIComponent(msg));

app.get("/portal/subscriptions/:id", requirePortal, async (req, res, next) => {
  try { const sub = await loadMySub(req, res); if (sub) await renderSubscription(req, res, sub); } catch (e) { next(e); }
});
/** สร้าง key — แสดง key เต็มบนหน้านี้ครั้งเดียว (ไม่ redirect เพื่อไม่ให้ key ไปอยู่ใน URL/ประวัติ) */
app.post("/portal/subscriptions/:id/keys", requirePortal, async (req, res, next) => {
  try {
    const sub = await loadMySub(req, res); if (!sub) return;
    if (!hit("key:" + req.portalUser.operator, 10, 10 * 60 * 1000)) return subRedirect(res, sub.id, "Too many keys created. Please wait a few minutes.", true);
    let key;
    try { key = await platform.createKey(q, sub, req.body.name); }
    catch (e) { if (isDbError(e)) throw e; return subRedirect(res, sub.id, e.message, true); }
    res.setHeader("Cache-Control", "no-store");
    await renderSubscription(req, res, await platform.getSubscription(q, sub.id), { newKey: key, msg: null });
  } catch (e) { next(e); }
});
app.post("/portal/keys/:id/revoke", requirePortal, async (req, res, next) => {
  try {
    const k = (await q("SELECT subscription_id FROM access_keys WHERE id = ? AND operator = ?", [Number(req.params.id), req.portalUser.operator]))[0];
    if (!k) return pnotFound(req, res, "Key");
    await platform.revokeKey(q, Number(req.params.id), req.portalUser.operator);
    subRedirect(res, k.subscription_id, "Key revoked — it stops working immediately.");
  } catch (e) { next(e); }
});
app.post("/portal/devices/:id/remove", requirePortal, async (req, res, next) => {
  try {
    const d = (await q("SELECT k.subscription_id FROM key_devices d JOIN access_keys k ON k.id = d.key_id WHERE d.id = ? AND k.operator = ?", [Number(req.params.id), req.portalUser.operator]))[0];
    if (!d) return pnotFound(req, res, "Device");
    await platform.removeDevice(q, Number(req.params.id), req.portalUser.operator);
    subRedirect(res, d.subscription_id, "Device removed — you can activate the license on another machine.");
  } catch (e) { next(e); }
});
/** ยกเลิก: Polar → ยกเลิกเมื่อครบรอบ (ใช้ได้ถึงวันสิ้นสุด), ฟรี/ตามใช้งาน → หยุดทันที */
app.post("/portal/subscriptions/:id/cancel", requirePortal, async (req, res, next) => {
  try {
    const sub = await loadMySub(req, res); if (!sub) return;
    if (sub.source === "polar" && sub.provider_sub_id) {
      try { await polar.setCancelAtPeriodEnd(sub.provider_sub_id, true); }
      catch (e) { return subRedirect(res, sub.id, "Could not cancel: " + e.message, true); }
      await q("UPDATE subscriptions SET cancel_at_period_end = 1 WHERE id = ?", [sub.id]);
      return subRedirect(res, sub.id, `Cancelled. Your plan stays active until ${fmtDate(sub.period_end)} and will not renew.`);
    }
    if (sub.source === "manual") return subRedirect(res, sub.id, "This plan was set up by our team — please contact support to cancel it.", true);
    await platform.setStatus(q, sub.id, "cancelled");
    subRedirect(res, sub.id, "Plan cancelled. Usage up to today will still be invoiced at the end of the month.");
  } catch (e) { next(e); }
});
app.post("/portal/subscriptions/:id/resume", requirePortal, async (req, res, next) => {
  try {
    const sub = await loadMySub(req, res); if (!sub) return;
    if (!(sub.source === "polar" && sub.provider_sub_id && sub.cancel_at_period_end)) return subRedirect(res, sub.id, "Nothing to resume.", true);
    try { await polar.setCancelAtPeriodEnd(sub.provider_sub_id, false); }
    catch (e) { return subRedirect(res, sub.id, "Could not resume: " + e.message, true); }
    await q("UPDATE subscriptions SET cancel_at_period_end = 0 WHERE id = ?", [sub.id]);
    subRedirect(res, sub.id, "Your plan will renew automatically.");
  } catch (e) { next(e); }
});
/** ไป Customer Portal ของ Polar (เปลี่ยนบัตร / ดูใบเสร็จค่าสมาชิก) */
app.get("/portal/payment-methods", requirePortal, async (req, res, next) => {
  try {
    if (payments.info().key !== "polar" || !payments.info().ready) return res.redirect("/portal/billing");
    const url = await polar.customerPortalUrl(req.portalUser.operator);
    res.redirect(url || "/portal/billing");
  } catch (e) {
    console.error("[polar customer portal]", e.message);
    res.redirect("/portal/billing");
  }
});

/** หน้าการชำระเงินของลูกค้า: ใบแจ้งหนี้ + ปุ่มจ่ายผ่านผู้ให้บริการรับชำระเงิน */
app.get("/portal/billing", requirePortal, async (req, res, next) => {
  try {
    const u = req.portalUser, op = u.operator;
    const inv = await q(`SELECT i.*, COALESCE(NULLIF(i.receipt_url, ''), o.receipt_url, '') AS receipt_url FROM billing_invoices i LEFT JOIN billing_orders o ON o.order_id = i.ls_order_id
                         WHERE i.operator = ? ORDER BY i.issued_at DESC, i.id DESC LIMIT 60`, [op]);
    const sum = { open: 0, open_n: 0, paid: 0 };
    for (const r of inv) { if (r.status === "open") { sum.open += Number(r.amount_thb); sum.open_n++; } if (r.status === "paid") sum.paid += Number(r.amount_thb); }
    const files = {};
    for (const a of await invoices.listAttachments(q, inv.map(r => r.id))) (files[a.invoice_id] ||= []).push(a);
    // ค่าใช้งานเกินโควตาที่สะสมเดือนนี้ (ยังไม่ออกบิล)
    const meter = await q(`SELECT COALESCE(SUM(GREATEST(0, c.units - COALESCE(pl.included_units, c.units)) * pl.unit_price_thb), 0) amt
                           FROM usage_counters c JOIN subscriptions s ON s.id = c.subscription_id JOIN product_plans pl ON pl.id = s.plan_id
                           WHERE s.operator = ? AND c.ym = ? AND pl.unit_price_thb > 0`, [op, thisMonth()]);
    pview(req, res, "billing", { title: "Billing", pageTitle: "Invoices & payments", invoices: inv, files, sum, currentEstimate: Number(meter[0].amt || 0),
      today: new Date().toISOString().slice(0, 10), paidNo: String(req.query.paid || "").slice(0, 32) || null, profileComplete: profileComplete(u), pay: payments.info() });
  } catch (e) { next(e); }
});
app.get("/portal/profile", requirePortal, (req, res) => pview(req, res, "profile", { title: "Billing details", error: null, saved: req.query.saved === "1" }));
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
app.get("/portal/password", requirePortal, (req, res) => pview(req, res, "password", { title: "Change password", error: null, saved: req.query.saved === "1" }));
app.post("/portal/password", requirePortal, async (req, res, next) => {
  try {
    const u = req.portalUser, { current = "", next: nx = "", confirm = "" } = req.body;
    const render = (error) => pview(req, res, "password", { title: "Change password", error, saved: false }, 400);
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
    if (!inv) return pnotFound(req, res, "Invoice");
    pview(req, res, "invoice", { title: "Billing", pageTitle: inv.invoice_no, ...(await invoiceDoc(inv)) });
  } catch (e) { next(e); }
});
app.get("/portal/attachments/:id", requirePortal, async (req, res, next) => {
  try {
    const a = await invoices.getAttachment(q, req.params.id);
    const owner = a && (await q("SELECT 1 FROM billing_invoices WHERE id = ? AND operator = ?", [a.invoice_id, req.portalUser.operator]))[0];
    if (!owner) return pnotFound(req, res, "File");
    sendAttachment(res, a);
  } catch (e) { next(e); }
});

/** บริการแบบจ่ายครั้งเดียว: เลือกบริการ → ตรวจสอบคำสั่งซื้อ → ไปหน้าชำระเงินของ Polar */
const renderServices = async (req, res, error = null, status = 200) => pview(req, res, "services", { title: "Services", rows: await services.listActive(q), error }, status);
app.get("/portal/services", requirePortal, async (req, res, next) => {
  try { await renderServices(req, res); } catch (e) { next(e); }
});
app.get("/portal/services/:id", requirePortal, async (req, res, next) => {
  try {
    const svc = await services.get(q, req.params.id);
    if (!svc || !svc.is_active) return renderServices(req, res, "This service is no longer available.", 404);
    pview(req, res, "checkout", { title: "Services", pageTitle: "Review order", svc, error: null, profileComplete: profileComplete(req.portalUser) });
  } catch (e) { next(e); }
});
app.post("/portal/services/:id/buy", requirePortal, async (req, res, next) => {
  const u = req.portalUser;
  let svc = null;
  const back = (error, status = 400) => pview(req, res, "checkout", { title: "Services", pageTitle: "Review order", svc, error, profileComplete: profileComplete(u) }, status);
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
    if (isDbError(e)) return next(e);
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
  res.redirect("/login");
};

// =========================== admin ===========================
const admin = express.Router();
admin.use(requireAuth);
const back = (res, url, msg, isError = false) => res.redirect(url + (url.includes("?") ? "&" : "?") + (isError ? "error=" : "msg=") + encodeURIComponent(msg));

/** ภาพรวมธุรกิจ: MRR, subscription, รายได้, ค้างชำระ, การใช้งานเดือนนี้ */
admin.get("/", async (req, res, next) => {
  try {
    const ym = thisMonth();
    const [mrr, counts, revenue, outstanding, topUsage, recent, perProduct] = await Promise.all([
      q(`SELECT COALESCE(SUM(CASE pl.billing WHEN 'month' THEN pl.price_thb WHEN 'year' THEN pl.price_thb / 12 ELSE 0 END), 0) mrr
         FROM subscriptions s JOIN product_plans pl ON pl.id = s.plan_id WHERE s.status = 'active' AND s.source <> 'free'`),
      q(`SELECT SUM(status = 'active') active, SUM(status = 'past_due') past_due, SUM(status = 'active' AND DATE_FORMAT(created_at, '%Y-%m') = ?) new_this_month,
                COUNT(DISTINCT CASE WHEN status = 'active' THEN operator END) customers FROM subscriptions`, [ym]),
      q("SELECT COALESCE(SUM(amount_thb), 0) s, COUNT(*) n FROM billing_invoices WHERE status = 'paid' AND DATE_FORMAT(paid_at, '%Y-%m') = ?", [ym]),
      q("SELECT COALESCE(SUM(amount_thb), 0) s, COUNT(*) n, SUM(due_at < CURDATE()) overdue FROM billing_invoices WHERE status = 'open'"),
      q(`SELECT c.units, c.requests, s.id, s.operator, p.name product_name, p.unit_label, pl.name plan_name, pl.included_units
         FROM usage_counters c JOIN subscriptions s ON s.id = c.subscription_id JOIN products p ON p.id = s.product_id JOIN product_plans pl ON pl.id = s.plan_id
         WHERE c.ym = ? ORDER BY c.units DESC LIMIT 10`, [ym]),
      q(`${platform.SUB_SELECT} ORDER BY s.created_at DESC LIMIT 8`),
      q(`SELECT p.id, p.name, p.kind, SUM(s.status = 'active') active, COALESCE(SUM(c.units), 0) units FROM products p
         LEFT JOIN subscriptions s ON s.product_id = p.id LEFT JOIN usage_counters c ON c.subscription_id = s.id AND c.ym = ?
         GROUP BY p.id ORDER BY p.sort_order, p.name`, [ym]),
    ]);
    res.render("dashboard", { title: "Overview", ym, mrr: Number(mrr[0].mrr), counts: counts[0], revenue: revenue[0], outstanding: outstanding[0], topUsage, recent, perProduct, coMissing: company().missing, pay: payments.info() });
  } catch (e) { next(e); }
});

// ---- สินค้า + แพ็กเกจ ----
admin.get("/products", async (req, res, next) => {
  try { res.render("products", { title: "Products", products: await platform.listProducts(q), msg: req.query.msg || null }); } catch (e) { next(e); }
});
async function renderProduct(req, res, id, extra = {}) {
  const products = id ? await platform.listProducts(q) : [];
  const product = id ? products.find(p => p.id === Number(id)) : null;
  if (id && !product) return res.status(404).render("error", { title: "Product not found", message: "No product with this id.", detail: "" });
  const subs = id ? (await q("SELECT plan_id, COUNT(*) n FROM subscriptions WHERE product_id = ? AND status = 'active' GROUP BY plan_id", [id])) : [];
  const editPlan = product && req.query.plan ? product.plans.find(p => p.id === Number(req.query.plan)) : null;
  res.render("product", { title: "Products", product, form: null, editPlan, planForm: null, subsByPlan: Object.fromEntries(subs.map(s => [s.plan_id, s.n])),
    pay: payments.info(), base: siteUrl(), secret: null, msg: req.query.msg || null, error: req.query.error || null, ...extra });
}
admin.get("/products/new", (req, res, next) => renderProduct(req, res, null).catch(next));
admin.get("/products/:id(\\d+)", (req, res, next) => renderProduct(req, res, req.params.id).catch(next));
admin.post("/products", async (req, res, next) => {
  try { const id = await platform.saveProduct(q, null, req.body); res.redirect(`/admin/products/${id}?msg=` + encodeURIComponent("Product created — now add its plans")); }
  catch (e) { if (isDbError(e)) return next(e); renderProduct(req, res, null, { error: e.message, form: req.body }).catch(next); }
});
admin.post("/products/:id(\\d+)", async (req, res, next) => {
  try { await platform.saveProduct(q, Number(req.params.id), req.body); back(res, `/admin/products/${req.params.id}`, "Product saved"); }
  catch (e) { if (isDbError(e)) return next(e); renderProduct(req, res, req.params.id, { error: e.message, form: req.body }).catch(next); }
});
admin.post("/products/:id(\\d+)/toggle", async (req, res, next) => {
  try { await q("UPDATE products SET is_active = 1 - is_active WHERE id = ?", [Number(req.params.id)]); back(res, `/admin/products/${req.params.id}`, "Visibility updated"); } catch (e) { next(e); }
});
/** สร้าง service secret ใหม่ — แสดงครั้งเดียวบนหน้านี้ (ไม่ใส่ใน URL) */
admin.post("/products/:id(\\d+)/secret", async (req, res, next) => {
  try { const secret = await platform.rotateServiceSecret(q, Number(req.params.id)); res.setHeader("Cache-Control", "no-store"); await renderProduct(req, res, req.params.id, { secret }); }
  catch (e) { next(e); }
});
admin.post("/products/:id(\\d+)/plans", async (req, res, next) => {
  try { await platform.savePlan(q, Number(req.params.id), null, req.body, invoices.MIN_THB); back(res, `/admin/products/${req.params.id}`, "Plan added"); }
  catch (e) { if (isDbError(e)) return next(e); renderProduct(req, res, req.params.id, { error: e.message, planForm: req.body }).catch(next); }
});
admin.post("/plans/:id(\\d+)", async (req, res, next) => {
  const pl = (await q("SELECT product_id FROM product_plans WHERE id = ?", [Number(req.params.id)]).catch(() => []))[0];
  if (!pl) return res.redirect("/admin/products");
  try { await platform.savePlan(q, pl.product_id, Number(req.params.id), req.body, invoices.MIN_THB); back(res, `/admin/products/${pl.product_id}`, "Plan saved"); }
  catch (e) {
    if (isDbError(e)) return next(e);
    req.query.plan = req.params.id;
    renderProduct(req, res, pl.product_id, { error: e.message, planForm: req.body }).catch(next);
  }
});
admin.post("/plans/:id(\\d+)/toggle", async (req, res, next) => {
  try {
    const pl = (await q("SELECT product_id FROM product_plans WHERE id = ?", [Number(req.params.id)]))[0];
    if (!pl) return res.redirect("/admin/products");
    await q("UPDATE product_plans SET is_active = 1 - is_active WHERE id = ?", [Number(req.params.id)]);
    back(res, `/admin/products/${pl.product_id}`, "Plan visibility updated (existing subscribers keep their plan)");
  } catch (e) { next(e); }
});

// ---- subscriptions ----
admin.get("/subscriptions", async (req, res, next) => {
  try {
    const status = platform.SUB_STATUS[req.query.status] ? req.query.status : "";
    const product = Number(req.query.product) || 0, operator = String(req.query.operator || "").trim().slice(0, 100);
    const where = [], params = [];
    if (status) { where.push("s.status = ?"); params.push(status); } else where.push("s.status <> 'expired'");
    if (product) { where.push("s.product_id = ?"); params.push(product); }
    if (operator) { where.push("s.operator = ?"); params.push(operator); }
    const rows = await q(`${platform.SUB_SELECT} WHERE ${where.join(" AND ")} ORDER BY FIELD(s.status,'past_due','active','pending','cancelled','expired'), s.created_at DESC LIMIT 500`, params);
    const ym = thisMonth();
    const use = rows.length ? await q("SELECT subscription_id, units FROM usage_counters WHERE ym = ? AND subscription_id IN (?)", [ym, rows.map(r => r.id)]) : [];
    for (const r of rows) r.used = Number((use.find(u => u.subscription_id === r.id) || {}).units || 0);
    const [products, ops] = await Promise.all([platform.listProducts(q), q("SELECT operator FROM portal_users ORDER BY operator")]);
    res.render("subscriptions", { title: "Subscriptions", rows, products, operators: ops.map(o => o.operator), filters: { status, product, operator }, msg: req.query.msg || null, error: req.query.error || null });
  } catch (e) { next(e); }
});
/** แอดมินเปิดแพ็กเกจให้ลูกค้าเอง (ทดลองใช้ / โอนเงิน / ลูกค้าองค์กร) — ไม่ผ่าน Polar */
admin.post("/subscriptions/grant", async (req, res, next) => {
  const ret = req.body.back === "customer" ? `/admin/customers/${encodeURIComponent(req.body.operator || "")}` : "/admin/subscriptions";
  try {
    const operator = String(req.body.operator || "").trim();
    if (!(await q("SELECT 1 FROM portal_users WHERE operator = ?", [operator]))[0]) return back(res, ret, `Customer account "${operator}" does not exist — create it under Customers first`, true);
    const plan = await platform.getPlan(q, req.body.plan_id);
    if (!plan) return back(res, ret, "Choose a plan", true);
    const months = Math.max(0, Math.trunc(Number(req.body.months) || 0));
    const id = await platform.createSubscription(q, operator, plan, { source: "manual", months: months || null, note: req.body.note || "Granted by admin" });
    await platform.supersedeOthers(q, operator, plan.product_id, id);
    back(res, ret, `${plan.product_name} · ${plan.name} granted to ${operator}${months ? ` for ${months} month(s)` : " (no end date)"}`);
  } catch (e) { if (isDbError(e)) return next(e); back(res, ret, e.message, true); }
});
admin.post("/subscriptions/:id(\\d+)/cancel", async (req, res, next) => {
  const ret = req.body.back || "/admin/subscriptions";
  try {
    const sub = await platform.getSubscription(q, req.params.id);
    if (!sub) return back(res, ret, "Subscription not found", true);
    if (sub.source === "polar" && sub.provider_sub_id) {
      try { await polar.revokeSubscription(sub.provider_sub_id); } catch (e) { return back(res, ret, "Polar refused the cancellation: " + e.message, true); }
    }
    await platform.setStatus(q, sub.id, "cancelled", { cancel_at_period_end: 0, period_end: new Date() });
    back(res, ret, `Subscription #${sub.id} cancelled — keys stop working immediately`);
  } catch (e) { next(e); }
});
admin.post("/subscriptions/:id(\\d+)/extend", async (req, res, next) => {
  const ret = req.body.back || "/admin/subscriptions";
  try {
    const months = Math.max(1, Math.min(60, Math.trunc(Number(req.body.months) || 1)));
    const sub = await platform.getSubscription(q, req.params.id);
    if (!sub) return back(res, ret, "Subscription not found", true);
    if (sub.source === "polar") return back(res, ret, "Polar subscriptions renew through Polar — extend manual plans only", true);
    await q("UPDATE subscriptions SET status = 'active', period_end = DATE_ADD(GREATEST(COALESCE(period_end, NOW()), NOW()), INTERVAL ? MONTH) WHERE id = ?", [months, sub.id]);
    back(res, ret, `Subscription #${sub.id} extended by ${months} month(s)`);
  } catch (e) { next(e); }
});
admin.post("/keys/:id(\\d+)/revoke", async (req, res, next) => {
  try { await platform.revokeKey(q, Number(req.params.id)); back(res, req.body.back || "/admin/subscriptions", "Key revoked"); } catch (e) { next(e); }
});
admin.post("/devices/:id(\\d+)/remove", async (req, res, next) => {
  try { await platform.removeDevice(q, Number(req.params.id)); back(res, req.body.back || "/admin/subscriptions", "Device removed"); } catch (e) { next(e); }
});

// ---- ใบแจ้งหนี้ ----
const INV_FILTERS = { open: "i.status = 'open'", overdue: "i.status = 'open' AND i.due_at < CURDATE()", paid: "i.status = 'paid'", void: "i.status = 'void'", carried: "i.status = 'carried'",
  manual: "i.kind = 'manual'", usage: "i.kind = 'usage'", subscription: "i.kind = 'subscription'" };
async function renderInvoices(req, res, next, extra = {}) {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const all = src.ym === "all", ym = all ? "all" : validYm(src.ym);
    const status = INV_FILTERS[src.status] ? src.status : "", operator = String(src.operator || "").trim().slice(0, 100);
    const where = [], params = [];
    if (!all) { where.push("i.ym = ?"); params.push(ym); }
    if (status) where.push(INV_FILTERS[status]);
    if (operator) { where.push("i.operator = ?"); params.push(operator); }
    const [rows, months, carried, svcRows, opsRows] = await Promise.all([
      q(`SELECT i.*, p.company_name, (SELECT COUNT(*) FROM billing_attachments a WHERE a.invoice_id = i.id) files
         FROM billing_invoices i LEFT JOIN portal_users p ON p.operator = i.operator
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY FIELD(i.status,'open','carried','paid','void'), i.issued_at DESC, i.id DESC LIMIT 500`, params),
      invoiceMonths(),
      q("SELECT COALESCE(SUM(amount_thb),0) s FROM billing_invoices WHERE status = 'carried'"),
      services.listAll(q),
      q("SELECT operator FROM portal_users ORDER BY operator"),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const sum = { open: 0, open_n: 0, paid: 0, paid_n: 0, overdue_n: 0, carried: Number(carried[0].s || 0) };
    for (const r of rows) {
      if (r.status === "open") { sum.open += Number(r.amount_thb); sum.open_n++; if (r.due_at && r.due_at < today) sum.overdue_n++; }
      if (r.status === "paid") { sum.paid += Number(r.amount_thb); sum.paid_n++; }
    }
    const pay = payments.info();
    res.render("invoices", { title: "Invoices", ym, months, rows, sum, today, operators: opsRows.map(r => r.operator), filters: { status, operator }, services: svcRows,
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
    if (isDbError(e)) return next(e);
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
  if (isDbError(e)) return next(e);
  if (req.body && req.body.back === "detail") return invRedirect(req, res, id, e.message, true);
  renderInvoices(req, res, next, { error: e.message });
};
admin.get("/invoices/:id(\\d+)", async (req, res, next) => {
  try {
    const inv = (await q("SELECT * FROM billing_invoices WHERE id = ?", [Number(req.params.id)]))[0];
    if (!inv) return res.status(404).render("error", { title: "Invoice not found", message: "No invoice with this id.", detail: "" });
    res.render("invoice", { title: "Invoices", co: company(), pay: payments.info(), siteUrl: siteUrl(), ATTACH_KINDS: invoices.ATTACH_KINDS,
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

// ---- บริการแบบจ่ายครั้งเดียว (แสดงในพอร์ทัลลูกค้า ให้กดซื้อ/จ่ายเองได้) ----
const renderSvcAdmin = async (res, extra) => {
  const rows = await services.listAll(q);
  res.status(extra.error ? 400 : 200).render("services", { title: "Services", rows, editing: null, pay: payments.info(), msg: null, error: null, ...extra, ...(extra.editId ? { editing: rows.find(r => r.id === extra.editId) } : {}) });
};
admin.get("/services", async (req, res, next) => {
  try { await renderSvcAdmin(res, { msg: req.query.msg || null, editId: req.query.edit ? Number(req.query.edit) : null }); } catch (e) { next(e); }
});
const svcData = (b) => ({ name: b.name, description: b.description, price_thb: b.price_thb, payment_link: b.payment_link, sort_order: b.sort_order, minThb: invoices.MIN_THB });
admin.post("/services", async (req, res, next) => {
  try { await services.create(q, svcData(req.body)); res.redirect("/admin/services?msg=" + encodeURIComponent("Service added")); }
  catch (e) { if (isDbError(e)) return next(e); renderSvcAdmin(res, { error: e.message }).catch(next); }
});
admin.post("/services/:id/update", async (req, res, next) => {
  try { await services.update(q, Number(req.params.id), svcData(req.body)); res.redirect("/admin/services?msg=" + encodeURIComponent("Service updated")); }
  catch (e) { if (isDbError(e)) return next(e); renderSvcAdmin(res, { error: e.message, editId: Number(req.params.id) }).catch(next); }
});
admin.post("/services/:id/toggle", async (req, res, next) => {
  try { await services.toggle(q, Number(req.params.id)); res.redirect("/admin/services"); } catch (e) { next(e); }
});
admin.post("/services/:id/delete", async (req, res, next) => {
  try { await services.remove(q, Number(req.params.id)); res.redirect("/admin/services?msg=" + encodeURIComponent("Service deleted")); } catch (e) { next(e); }
});

// ---- ลูกค้า ----
async function renderCustomers(req, res, next, extra = {}) {
  try {
    const rows = await q(`SELECT p.id, p.operator, p.serial_no, p.display_name, p.company_name, p.email, p.is_active, p.must_change, p.last_login_at, p.last_verified_at,
                                 (SELECT COUNT(*) FROM license_devices d WHERE d.operator = p.operator) devices,
                                 (SELECT COUNT(*) FROM subscriptions s WHERE s.operator = p.operator AND s.status = 'active') subs,
                                 (SELECT COALESCE(SUM(amount_thb),0) FROM billing_invoices i WHERE i.operator = p.operator AND i.status = 'open') owed
                          FROM portal_users p ORDER BY p.operator`);
    res.render("portal_users", { title: "Customers", rows, siteUrl: siteUrl(), msg: req.query.msg || null, error: null, ...extra });
  } catch (e) { next(e); }
}
admin.get("/customers", (req, res, next) => renderCustomers(req, res, next));
admin.get("/portal-users", (req, res) => res.redirect(301, "/admin/customers"));
admin.post("/customers", async (req, res, next) => {
  try {
    const op = await portal.createUser(q, { operator: req.body.operator, password: req.body.password, display_name: req.body.display_name, email: req.body.email, must_change: req.body.must_change ? 1 : 0 });
    res.redirect("/admin/customers?msg=" + encodeURIComponent("Account '" + op + "' saved"));
  } catch (e) {
    if (isDbError(e)) return next(e);
    renderCustomers(req, res, next, { error: e.message });
  }
});
admin.post("/customers/:id(\\d+)/serial", async (req, res, next) => {
  try { const sn = await portal.regenerateSerial(q, Number(req.params.id)); res.redirect("/admin/customers?msg=" + encodeURIComponent("New serial issued: " + sn + " (the old one no longer works)")); }
  catch (e) { next(e); }
});
admin.post("/customers/:id(\\d+)/toggle", async (req, res, next) => {
  try { await q("UPDATE portal_users SET is_active = 1 - is_active WHERE id = ?", [Number(req.params.id)]); res.redirect("/admin/customers"); }
  catch (e) { next(e); }
});
/** หน้าลูกค้ารายคน: subscription + key + เครื่อง + ใบแจ้งหนี้ + SN เดิม */
admin.get("/customers/:operator", async (req, res, next) => {
  try {
    const operator = String(req.params.operator).slice(0, 100);
    const acct = (await q("SELECT * FROM portal_users WHERE operator = ?", [operator]))[0];
    if (!acct) return res.status(404).render("error", { title: "Customer not found", message: `No account "${operator}".`, detail: "" });
    const subs = await q(`${platform.SUB_SELECT} WHERE s.operator = ? ORDER BY FIELD(s.status,'active','past_due','pending','cancelled','expired'), s.created_at DESC`, [operator]);
    const ids = subs.map(s => s.id), ym = thisMonth();
    const [use, inv, devices, products] = await Promise.all([
      ids.length ? q("SELECT subscription_id, units FROM usage_counters WHERE ym = ? AND subscription_id IN (?)", [ym, ids]) : [],
      q("SELECT * FROM billing_invoices WHERE operator = ? ORDER BY issued_at DESC, id DESC LIMIT 50", [operator]),
      q("SELECT * FROM license_devices WHERE operator = ? ORDER BY last_seen DESC", [operator]),
      platform.listProducts(q),
    ]);
    for (const s of subs) { s.used = Number((use.find(u => u.subscription_id === s.id) || {}).units || 0); s.live = platform.isLive(s); s.keys = await platform.listKeys(q, s.id); }
    res.render("customer", { title: "Customers", acct, subs, invoices: inv, devices, products, ym, today: new Date().toISOString().slice(0, 10), msg: req.query.msg || null, error: req.query.error || null });
  } catch (e) { next(e); }
});

// ---- ผู้ให้บริการรับชำระเงิน (ตั้งค่า + webhook ล่าสุด) ----
admin.get("/billing", async (req, res, next) => {
  try {
    const [orders, events] = await Promise.all([
      q("SELECT * FROM billing_orders ORDER BY ordered_at DESC LIMIT 50"),
      q("SELECT id, event_name, object_type, object_id, received_at FROM billing_events ORDER BY id DESC LIMIT 40"),
    ]);
    const pay = payments.info();
    res.render("billing", { title: "Payments", orders, events, pay, lsReady: pay.ready, webhookReady: pay.webhookReady, siteUrl: siteUrl() });
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

// ---- errors ----
const errView = (req) => req.path.startsWith("/portal") ? "portal/error" : req.path.startsWith("/admin") ? "error" : "site/error";
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, error: "not_found" });
  res.status(404).render(errView(req), { user: req.portalUser || null, co: company(), path: req.path, title: "Page not found", message: "The page you requested does not exist.", detail: req.path });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ ok: false, error: "invalid_json", message: "Request body must be valid JSON" });
  console.error(err);
  if (req.path.startsWith("/api/")) return res.status(500).json({ ok: false, error: "server", message: "Server error" });
  const dbDown = ["ECONNREFUSED", "ETIMEDOUT", "ER_ACCESS_DENIED_ERROR", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST", "ER_NO_SUCH_TABLE"].includes(err.code);
  const view = errView(req), adminView = view === "error";
  res.status(500).render(view, {
    co: company(), path: req.path, title: "Something went wrong", user: req.portalUser || null,
    message: !adminView ? "We couldn't complete your request. Please try again in a few minutes — if it keeps happening, contact support."
      : dbDown ? "Database connection failed — check DB_* in .env, the database user's privileges, and that the sql/*.sql files were applied (sql/platform_schema.sql for products & plans)." : "An internal error occurred.",
    detail: !adminView ? "" : `${err.code || ""} ${err.sqlMessage || err.message || ""}`.trim(),
  });
});

app.listen(PORT, () => console.log(`✓ web http://localhost:${PORT}  (admin: /admin · API: /api/v1)`));
