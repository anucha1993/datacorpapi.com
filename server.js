/**
 * เว็บไซต์ + ระบบหลังบ้านของ e-WorkPermit Tools
 *   /            หน้าเว็บสาธารณะ: สินค้า ราคา นโยบาย ติดต่อ สมัคร/ชำระเงินผ่าน Lemon Squeezy
 *   /admin       หน้าหลังบ้าน (รหัสผ่าน): ยอดการใช้งาน ลูกค้า ส่งยอดไป Lemon Squeezy
 *   /webhooks/lemonsqueezy   รับเหตุการณ์คำสั่งซื้อ/subscription จาก Lemon Squeezy
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
const mysql = require("mysql2/promise");
const ls = require("./lib/lemonsqueezy");
const billing = require("./lib/billing");
const { company } = require("./lib/company");
const portal = require("./lib/portal");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const LS_API_KEY = (process.env.LS_API_KEY || "").trim();
const LS_WEBHOOK_SECRET = (process.env.LS_WEBHOOK_SECRET || "").trim();
const LS_USAGE_ACTION = (process.env.LS_USAGE_ACTION || "set").trim() === "increment" ? "increment" : "set";
const LS_USAGE_QUANTITY = (process.env.LS_USAGE_QUANTITY || "amount").trim() === "records" ? "records" : "amount";

// ไม่ปิดแอปถ้ายังไม่ได้ตั้งรหัส admin — หน้าเว็บสาธารณะต้องเปิดได้เสมอ แค่ปิดการ login หลังบ้านไว้
const ADMIN_DISABLED = !ADMIN_PASSWORD;
if (ADMIN_DISABLED) console.error("⚠ ยังไม่ได้ตั้ง ADMIN_PASSWORD ใน .env — หน้า /admin จะเข้าไม่ได้จนกว่าจะตั้งค่า");
{
  const co = company();
  if (!co.isComplete) console.warn("⚠ ข้อมูลธุรกิจยังไม่ครบใน .env (ผู้ให้บริการรับชำระเงินต้องเห็นบนเว็บ):", co.missing.join(", "));
  if (!LS_WEBHOOK_SECRET) console.warn("⚠ ยังไม่ได้ตั้ง LS_WEBHOOK_SECRET — webhook จะถูกปฏิเสธ");
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
  etracking: "e-Tracking — ดึงรายการคำขอ", permit_report: "รายงานข้อมูลการขออนุญาต",
  aliens: "ข้อมูลคนต่างด้าว (จัดการบัญชี)", namelist_alien: "รายชื่อยื่นต่ออายุแล้ว (NameList)",
  ticket: "ตรวจสอบ Ticket ID", receipts: "ใบเสร็จ / บต.44 / บต.22 ฯลฯ", results: "ใบแจ้งผล / ใบรับคำขอ",
  bill_payment: "ใบแจ้งชำระเงิน", payment_receipts: "ใบเสร็จรับเงินทั้งชุด", bt30_ctn: "ใบตอบรับ / ใบนัดหมาย",
  appointment: "นัดหมายถ่ายบัตร", register: "ลงทะเบียนคนต่างด้าว", inform: "แจ้งเข้านายจ้าง (บต.52)",
  bt30: "ต่อใบอนุญาต MoU (บต.30)", bt44: "เปลี่ยนย้ายนายจ้าง (บต.44)", booking_availability: "ตรวจวันว่างจอง (Real-Time)",
};
const MODE_GROUP = {
  etracking: "report", permit_report: "report", aliens: "report", namelist_alien: "report", ticket: "report",
  receipts: "download", results: "download", bill_payment: "download", payment_receipts: "download",
  bt30_ctn: "download", appointment: "download", register: "submit", inform: "submit", bt30: "submit",
  bt44: "submit", booking_availability: "booking",
};
const GROUP_LABELS = { report: "รายงาน", download: "ดาวน์โหลดเอกสาร", submit: "ยื่นคำขอ", booking: "คิวถ่ายบัตร" };
const STATUS_LABELS = { ok: "สำเร็จ", cancelled: "ยกเลิก", error: "ผิดพลาด" };

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const validYm = (s) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(s || "") ? s : thisMonth());
const fmtNum = (n) => Number(n || 0).toLocaleString("th-TH");
const fmtMoney = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtDur(sec) {
  sec = Number(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} ชม. ${m} น.`;
  if (m) return `${m} น. ${sec % 60} วิ`;
  return `${sec} วิ`;
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

app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.use(cookieSession({ name: "ewpusage", secret: SESSION_SECRET, httpOnly: true, sameSite: "lax", maxAge: 12 * 60 * 60 * 1000 }));

// =========================== หน้าเว็บสาธารณะ ===========================
const site = (req, res, view, extra = {}) => res.render(`site/${view}`, { co: company(), path: req.path, ...extra });

app.get("/", async (req, res) => site(req, res, "home", { title: "หน้าแรก", plans: loadPlans() }));
app.get("/pricing", async (req, res) => {
  const prices = (await qSafe("SELECT * FROM usage_prices ORDER BY mode")).map(p => ({ ...p, mode_group: MODE_GROUP[p.mode] || "" }));
  site(req, res, "pricing", { title: "ราคา", plans: loadPlans(), prices });
});
app.get("/terms", (req, res) => site(req, res, "terms", { title: "ข้อกำหนดการใช้บริการ" }));
app.get("/privacy", (req, res) => site(req, res, "privacy", { title: "นโยบายความเป็นส่วนตัว" }));
app.get("/refund", (req, res) => site(req, res, "refund", { title: "นโยบายการคืนเงินและยกเลิก" }));
app.get("/thanks", (req, res) => site(req, res, "thanks", { title: "ขอบคุณ" }));
app.get("/contact", (req, res) => site(req, res, "contact", { title: "ติดต่อเรา", sent: req.query.sent === "1", error: null, form: {} }));
app.post("/contact", async (req, res) => {
  const form = { name: String(req.body.name || "").trim().slice(0, 190), email: String(req.body.email || "").trim().slice(0, 190),
                 company: String(req.body.company || "").trim().slice(0, 190), message: String(req.body.message || "").trim().slice(0, 4000) };
  if (String(req.body.website || "")) return res.redirect("/contact?sent=1"); // honeypot
  if (!hit("contact:" + req.ip, 5, 60 * 60 * 1000)) return site(req, res, "contact", { title: "ติดต่อเรา", sent: false, error: "ส่งข้อความบ่อยเกินไป กรุณาลองใหม่ภายหลัง", form });
  if (!form.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email) || !form.message)
    return site(req, res, "contact", { title: "ติดต่อเรา", sent: false, error: "กรุณากรอกชื่อ อีเมล และข้อความให้ครบ", form });
  try {
    await q("INSERT INTO contact_messages (name, email, company, message, ip) VALUES (?,?,?,?,?)", [form.name, form.email, form.company, form.message, String(req.ip).slice(0, 64)]);
  } catch (e) {
    console.error("[contact]", e.code || e.message);
    return site(req, res, "contact", { title: "ติดต่อเรา", sent: false, error: `บันทึกข้อความไม่ได้ กรุณาอีเมลถึง ${company().COMPANY_EMAIL || "เรา"} โดยตรง`, form });
  }
  res.redirect("/contact?sent=1");
});
/** ส่งต่อไปหน้า checkout ของ Lemon Squeezy พร้อม prefill อีเมล + custom data (operator/company) */
app.get("/checkout/:plan", (req, res) => {
  const plan = loadPlans().find(p => p.key === req.params.plan);
  if (!plan || !plan.checkout_url) return res.status(404).render("site/error", { co: company(), path: req.path, title: "ไม่พบแพ็กเกจ", message: "ไม่พบแพ็กเกจที่เลือก หรือยังไม่เปิดขาย" });
  const email = String(req.query.email || "").trim().slice(0, 190);
  const operator = String(req.query.operator || "").trim().slice(0, 100);
  const co = String(req.query.company || "").trim().slice(0, 190);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !operator) return res.redirect("/pricing#plan-" + plan.key);
  res.redirect(ls.buildCheckoutUrl(plan.checkout_url, { email, operator, company: co }));
});
app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /admin\nDisallow: /login\nDisallow: /portal\nAllow: /\n"));
app.get("/api/health", async (req, res) => {
  const cfg = { admin_password: !ADMIN_DISABLED, company_complete: company().isComplete, lemonsqueezy_api: !!LS_API_KEY, webhook_secret: !!LS_WEBHOOK_SECRET, node: process.version };
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
    if (!hit("plogin:" + req.ip, 8, 10 * 60 * 1000)) return res.status(429).render("portal/login", { co: company(), error: "ลองผิดหลายครั้ง รอ 10 นาทีแล้วลองใหม่", operator });
    const u = await portal.authenticate(q, operator, req.body.password || "");
    if (!u) return res.status(401).render("portal/login", { co: company(), error: "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง", operator });
    req.session.portal = u.operator;
    res.redirect(u.must_change ? "/portal/password" : "/portal");
  } catch (e) { next(e); }
});
app.post("/portal/logout", (req, res) => { if (req.session) req.session.portal = null; res.redirect("/portal/login"); });

app.get("/portal", requirePortal, async (req, res, next) => {
  try {
    const u = req.portalUser, op = u.operator, ym = validYm(req.query.ym);
    const [byMode, runs, trend, subs, reps, monthsRows] = await Promise.all([
      q("SELECT v.*, p.price_per_record FROM v_usage_monthly v LEFT JOIN usage_prices p ON p.mode = v.mode WHERE v.ym = ? AND v.operator = ? ORDER BY v.amount_thb DESC", [ym, op]),
      q("SELECT * FROM usage_runs WHERE DATE_FORMAT(started_at,'%Y-%m') = ? AND operator = ? ORDER BY started_at DESC LIMIT 200", [ym, op]),
      q("SELECT ym, runs, billable_records, amount_thb FROM v_usage_monthly_by_operator WHERE operator = ? ORDER BY ym DESC LIMIT 12", [op]),
      q("SELECT s.product_name, s.status, s.status_formatted, s.renews_at, s.customer_portal_url FROM billing_subscriptions s JOIN billing_customers c ON c.customer_id = s.customer_id WHERE c.operator = ? ORDER BY s.updated_at DESC LIMIT 5", [op]),
      q("SELECT ym, quantity, amount_thb, ok, sent_at FROM billing_usage_reports WHERE operator = ? ORDER BY sent_at DESC", [op]),
      q("SELECT DISTINCT DATE_FORMAT(started_at,'%Y-%m') ym FROM usage_runs WHERE operator = ? ORDER BY ym DESC LIMIT 24", [op]),
    ]);
    const months = [...new Set([thisMonth(), ...monthsRows.map(r => r.ym)])].sort().reverse();
    const reports = {}; for (const r of reps) if (!reports[r.ym]) reports[r.ym] = r;
    const sum = (k) => byMode.reduce((a, r) => a + Number(r[k] || 0), 0);
    const totals = { amount: sum("amount_thb"), records: sum("billable_records"), runs: sum("runs"), ok: sum("runs_ok"), cancelled: sum("runs_cancelled"), error: sum("runs_error"), total_sec: sum("total_sec") };
    res.render("portal/dashboard", { co: company(), title: "ยอดการใช้งาน", user: u, ym, months, byMode, runs, trend, subs, reports, totals });
  } catch (e) { next(e); }
});
app.get("/portal/export.csv", requirePortal, async (req, res, next) => {
  try {
    const ym = validYm(req.query.ym);
    const rows = await q("SELECT * FROM v_usage_monthly WHERE ym = ? AND operator = ? ORDER BY amount_thb DESC", [ym, req.portalUser.operator]);
    const head = ["เดือน", "ผู้ใช้งาน", "ประเภทงาน", "จำนวนครั้ง", "สำเร็จ", "ยกเลิก", "ผิดพลาด", "รายการที่คิดเงิน", "วินาทีรวม", "ค่าบริการ (บาท)"];
    const lines = [head.join(",")].concat(rows.map(r => [r.ym, r.operator, r.mode_label, r.runs, r.runs_ok, r.runs_cancelled, r.runs_error, r.billable_records, r.total_sec, r.amount_thb].map(csvCell).join(",")));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="usage_${req.portalUser.operator}_${ym}.csv"`);
    res.send("\uFEFF" + lines.join("\r\n"));
  } catch (e) { next(e); }
});
app.get("/portal/password", requirePortal, (req, res) => res.render("portal/password", { co: company(), title: "เปลี่ยนรหัสผ่าน", user: req.portalUser, error: null, saved: req.query.saved === "1" }));
app.post("/portal/password", requirePortal, async (req, res, next) => {
  try {
    const u = req.portalUser, { current = "", next: nx = "", confirm = "" } = req.body;
    const render = (error) => res.status(400).render("portal/password", { co: company(), title: "เปลี่ยนรหัสผ่าน", user: u, error, saved: false });
    if (!portal.verifyPassword(current, u.password_hash)) return render("รหัสผ่านปัจจุบันไม่ถูกต้อง");
    const err = portal.validatePassword(nx); if (err) return render(err);
    if (nx !== confirm) return render("รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน");
    await q("UPDATE portal_users SET password_hash = ?, must_change = 0 WHERE id = ?", [portal.hashPassword(nx), u.id]);
    res.redirect("/portal/password?saved=1");
  } catch (e) { next(e); }
});

// =========================== auth ===========================
app.get("/login", (req, res) => res.render("login", { error: ADMIN_DISABLED ? "ยังไม่ได้ตั้ง ADMIN_PASSWORD ในไฟล์ .env ของเซิร์ฟเวอร์" : null, title: "เข้าสู่ระบบ" }));
app.post("/login", (req, res) => {
  if (ADMIN_DISABLED) return res.status(503).render("login", { error: "ยังไม่ได้ตั้ง ADMIN_PASSWORD ในไฟล์ .env ของเซิร์ฟเวอร์", title: "เข้าสู่ระบบ" });
  if (!hit("login:" + req.ip, 5, 60 * 1000)) return res.status(429).render("login", { error: "ลองผิดหลายครั้ง รอ 1 นาทีแล้วลองใหม่", title: "เข้าสู่ระบบ" });
  if (safeEq(req.body.password || "", ADMIN_PASSWORD)) { req.session.auth = true; return res.redirect("/admin"); }
  res.status(401).render("login", { error: "รหัสผ่านไม่ถูกต้อง", title: "เข้าสู่ระบบ" });
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
    res.render("dashboard", { title: "ภาพรวม", ym, months, byOp, byMode, daily, totals: { ...totals[0], amount, records },
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
    res.render("operator", { title: `ผู้ใช้งาน: ${name}`, ym, months, name, byMode, runs, trend });
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
    res.render("runs", { title: "รายการงาน", ym, months, rows, ops, filters: { operator, mode, status }, page, pages: Math.max(1, Math.ceil(cnt[0].n / per)), total: cnt[0].n });
  } catch (e) { next(e); }
});

admin.get("/prices", async (req, res, next) => {
  try {
    const prices = await q("SELECT * FROM usage_prices ORDER BY mode");
    const known = new Set(prices.map(p => p.mode));
    res.render("prices", { title: "ตั้งราคา", prices, missing: Object.keys(MODE_LABELS).filter(m => !known.has(m)), saved: req.query.saved === "1" });
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
  try { res.render("installs", { title: "เครื่องที่ใช้งาน", rows: await q("SELECT * FROM v_usage_installs ORDER BY last_seen DESC") }); }
  catch (e) { next(e); }
});

admin.get("/export.csv", async (req, res, next) => {
  try {
    const ym = validYm(req.query.ym);
    const rows = await q("SELECT * FROM v_usage_monthly WHERE ym = ? ORDER BY operator, amount_thb DESC", [ym]);
    const head = ["เดือน", "ผู้ใช้งาน", "โหมด", "ชื่อโหมด", "กลุ่ม", "จำนวนครั้ง", "สำเร็จ", "ยกเลิก", "ผิดพลาด", "รายการที่คิดเงิน", "วินาทีรวม", "ยอดเงิน (บาท)"];
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
    res.render("billing", { title: "ลูกค้าและการชำระเงิน", subs, orders, events, operators, months, ym: validYm(req.query.ym || req.body?.ym),
      lsReady: !!LS_API_KEY, webhookReady: !!LS_WEBHOOK_SECRET, siteUrl: company().SITE_URL || "", report: null, ...extra });
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
admin.post("/billing/report-usage", async (req, res, next) => {
  const ym = validYm(req.body.ym);
  try {
    const results = await billing.reportUsage(q, ym, { apiKey: LS_API_KEY, action: LS_USAGE_ACTION, quantityMode: LS_USAGE_QUANTITY, log: console.log });
    renderBilling(req, res, next, { report: { ym, results } });
  } catch (e) { next(e); }
});

// ---- บัญชีลูกค้า Customer Portal ----
async function renderPortalUsers(req, res, next, extra = {}) {
  try {
    const [rows, ops1, ops2] = await Promise.all([
      q("SELECT id, operator, display_name, email, is_active, must_change, last_login_at FROM portal_users ORDER BY operator"),
      q("SELECT DISTINCT operator FROM usage_runs WHERE operator <> ''"),
      q("SELECT DISTINCT operator FROM billing_customers WHERE operator <> ''"),
    ]);
    const operators = [...new Set([...ops1, ...ops2].map(r => r.operator))].sort();
    res.render("portal_users", { title: "บัญชีลูกค้า", rows, operators, siteUrl: company().SITE_URL || "", msg: req.query.msg || null, error: null, ...extra });
  } catch (e) { next(e); }
}
admin.get("/portal-users", (req, res, next) => renderPortalUsers(req, res, next));
admin.post("/portal-users", async (req, res, next) => {
  try {
    const op = await portal.createUser(q, { operator: req.body.operator, password: req.body.password, display_name: req.body.display_name, email: req.body.email, must_change: req.body.must_change ? 1 : 0 });
    res.redirect("/admin/portal-users?msg=" + encodeURIComponent("บันทึกบัญชี '" + op + "' แล้ว"));
  } catch (e) {
    if (e.code && String(e.code).startsWith("ER_")) return next(e);
    renderPortalUsers(req, res, next, { error: e.message });
  }
});
admin.post("/portal-users/:id/toggle", async (req, res, next) => {
  try { await q("UPDATE portal_users SET is_active = 1 - is_active WHERE id = ?", [Number(req.params.id)]); res.redirect("/admin/portal-users"); }
  catch (e) { next(e); }
});

// ---- ข้อความติดต่อ ----
admin.get("/messages", async (req, res, next) => {
  try { res.render("messages", { title: "ข้อความ", rows: await q("SELECT * FROM contact_messages ORDER BY is_read, created_at DESC LIMIT 300") }); }
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
app.use((req, res) => {
  const pub = !req.path.startsWith("/admin") && !req.path.startsWith("/api") && !req.path.startsWith("/portal");
  res.status(404).render(pub ? "site/error" : "error", { co: company(), path: req.path, title: "ไม่พบหน้า", message: "ไม่พบหน้าที่ต้องการ", detail: req.path });
});
app.use((err, req, res, _next) => {
  console.error(err);
  const dbDown = ["ECONNREFUSED", "ETIMEDOUT", "ER_ACCESS_DENIED_ERROR", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST", "ER_NO_SUCH_TABLE"].includes(err.code);
  const pub = !req.path.startsWith("/admin") && !req.path.startsWith("/api") && !req.path.startsWith("/portal");
  res.status(500).render(pub ? "site/error" : "error", {
    co: company(), path: req.path, title: "เกิดข้อผิดพลาด",
    message: dbDown ? "เชื่อมต่อฐานข้อมูลไม่ได้ — ตรวจค่า DB_* ใน .env, สิทธิ์ของ user ewp_web และว่ารัน sql/billing_schema.sql แล้ว" : "เกิดข้อผิดพลาดในระบบ",
    detail: pub ? "" : `${err.code || ""} ${err.sqlMessage || err.message || ""}`.trim(),
  });
});

app.listen(PORT, () => console.log(`✓ ewp web http://localhost:${PORT}  (admin: /admin)`));
