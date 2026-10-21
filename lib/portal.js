"use strict";
/** บัญชีลูกค้าสำหรับ Customer Portal — hash รหัสผ่านด้วย scrypt (ไม่ต้องติดตั้งไลบรารีเพิ่ม) */
const crypto = require("crypto");

const N = 16384, R = 8, P = 1, KEYLEN = 32;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P }).toString("base64url");
  return `scrypt$${N}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, n, salt, hash] = String(stored || "").split("$");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(password), salt, KEYLEN, { N: Number(n) || N, r: R, p: P });
    const given = Buffer.from(hash, "base64url");
    return calc.length === given.length && crypto.timingSafeEqual(calc, given);
  } catch {
    return false;
  }
}

/** ชื่อผู้ใช้งาน: 2-100 ตัว ตัวอักษร/ตัวเลข/ไทย/._- เว้นวรรคได้ ไม่ขึ้นต้นด้วยช่องว่าง */
function normalizeOperator(v) {
  const s = String(v || "").trim().replace(/\s+/g, " ").slice(0, 100);
  return s.length >= 2 ? s : "";
}

function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 6) return "Password must be at least 6 characters";
  if (pw.length > 128) return "Password is too long";
  return null;
}

/** Serial number: DCA-XXXX-XXXX-XXXX (ตัดอักษรที่สับสน 0/O/1/I ออก) */
const SERIAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateSerial() {
  const bytes = crypto.randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) { s += SERIAL_ALPHABET[bytes[i] % SERIAL_ALPHABET.length]; if (i % 4 === 3 && i < 11) s += "-"; }
  return "DCA-" + s;
}
function normalizeSerial(v) {
  // รับได้ทั้งแบบมีขีด/ไม่มีขีด/พิมพ์เล็ก หรือวางมาทั้งประโยค — ดึงเฉพาะส่วนที่เป็น serial
  const m = String(v || "").toUpperCase().match(/DCA[\s\-_]*([A-Z0-9]{4})[\s\-_]*([A-Z0-9]{4})[\s\-_]*([A-Z0-9]{4})(?![A-Z0-9])/);
  return m ? `DCA-${m[1]}-${m[2]}-${m[3]}` : "";
}
/** ให้แน่ใจว่าบัญชีมี serial — คืน serial */
async function ensureSerial(q, operator) {
  const rows = await q("SELECT serial_no FROM portal_users WHERE operator = ?", [operator]);
  if (rows[0] && rows[0].serial_no) return rows[0].serial_no;
  for (let i = 0; i < 5; i++) {
    const sn = generateSerial();
    try { await q("UPDATE portal_users SET serial_no = ? WHERE operator = ?", [sn, operator]); return sn; }
    catch (e) { if (e.code !== "ER_DUP_ENTRY") throw e; }
  }
  throw new Error("Could not generate a unique serial");
}
async function regenerateSerial(q, id) {
  for (let i = 0; i < 5; i++) {
    const sn = generateSerial();
    try { await q("UPDATE portal_users SET serial_no = ? WHERE id = ?", [sn, id]); return sn; }
    catch (e) { if (e.code !== "ER_DUP_ENTRY") throw e; }
  }
  throw new Error("Could not generate a unique serial");
}
/**
 * ตรวจ serial จากโปรแกรม: คืน { ok, operator, display_name, status } หรือ { ok:false, error }
 * บันทึกเครื่องที่ตรวจไว้ใน license_devices
 */
async function verifySerial(q, { serial, install_id = "", machine = "", windows_user = "", app_version = "", ip = "" }) {
  const sn = normalizeSerial(serial);
  if (!sn) return { ok: false, error: "invalid_format", message: "Serial number format is invalid (DCA-XXXX-XXXX-XXXX)" };
  const rows = await q("SELECT id, operator, display_name, is_active, max_devices FROM portal_users WHERE serial_no = ? LIMIT 1", [sn]);
  const u = rows[0];
  if (!u) return { ok: false, error: "not_found", message: "Serial number not found" };
  if (!u.is_active) return { ok: false, error: "suspended", message: "This account is suspended — please contact support" };
  if (install_id) {
    if (u.max_devices > 0) {
      const known = await q("SELECT install_id FROM license_devices WHERE operator = ?", [u.operator]);
      if (!known.some(d => d.install_id === install_id) && known.length >= u.max_devices)
        return { ok: false, error: "device_limit", message: `Device limit reached (${u.max_devices}) — contact support to add this machine` };
    }
    await q(`INSERT INTO license_devices (operator, install_id, machine, windows_user, app_version, ip) VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE machine = VALUES(machine), windows_user = VALUES(windows_user), app_version = VALUES(app_version), ip = VALUES(ip), verify_count = verify_count + 1`,
      [u.operator, String(install_id).slice(0, 36), String(machine).slice(0, 64), String(windows_user).slice(0, 64), String(app_version).slice(0, 20), String(ip).slice(0, 64)]);
  }
  await q("UPDATE portal_users SET last_verified_at = NOW() WHERE id = ?", [u.id]);
  return { ok: true, operator: u.operator, display_name: u.display_name || u.operator, status: "active" };
}

async function createUser(q, { operator, password, display_name = "", email = "", must_change = 0 }) {
  const op = normalizeOperator(operator);
  if (!op) throw new Error("Invalid operator name");
  const err = validatePassword(password);
  if (err) throw new Error(err);
  await q(
    `INSERT INTO portal_users (operator, password_hash, display_name, email, must_change) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), display_name = IF(VALUES(display_name) <> '', VALUES(display_name), display_name),
       email = IF(VALUES(email) <> '', VALUES(email), email), must_change = VALUES(must_change), is_active = 1`,
    [op, hashPassword(password), String(display_name).slice(0, 190), String(email).slice(0, 190), must_change ? 1 : 0],
  );
  await ensureSerial(q, op);
  return op;
}

async function authenticate(q, operator, password) {
  const op = normalizeOperator(operator);
  if (!op) return null;
  const rows = await q("SELECT * FROM portal_users WHERE operator = ? LIMIT 1", [op]);
  const u = rows[0];
  if (!u || !u.is_active || !verifyPassword(password, u.password_hash)) return null;
  await q("UPDATE portal_users SET last_login_at = NOW() WHERE id = ?", [u.id]);
  return u;
}

module.exports = { hashPassword, verifyPassword, normalizeOperator, validatePassword, createUser, authenticate, generateSerial, normalizeSerial, ensureSerial, regenerateSerial, verifySerial };
