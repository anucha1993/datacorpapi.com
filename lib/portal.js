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
  if (typeof pw !== "string" || pw.length < 6) return "รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร";
  if (pw.length > 128) return "รหัสผ่านยาวเกินไป";
  return null;
}

async function createUser(q, { operator, password, display_name = "", email = "", must_change = 0 }) {
  const op = normalizeOperator(operator);
  if (!op) throw new Error("ชื่อผู้ใช้งานไม่ถูกต้อง");
  const err = validatePassword(password);
  if (err) throw new Error(err);
  await q(
    `INSERT INTO portal_users (operator, password_hash, display_name, email, must_change) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), display_name = IF(VALUES(display_name) <> '', VALUES(display_name), display_name),
       email = IF(VALUES(email) <> '', VALUES(email), email), must_change = VALUES(must_change), is_active = 1`,
    [op, hashPassword(password), String(display_name).slice(0, 190), String(email).slice(0, 190), must_change ? 1 : 0],
  );
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

module.exports = { hashPassword, verifyPassword, normalizeOperator, validatePassword, createUser, authenticate };
