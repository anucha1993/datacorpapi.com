"use strict";
/**
 * บัญชีผู้ดูแลระบบ (แทนรหัสผ่านเดียวใน .env)
 *   - รหัสผ่าน hash ด้วย scrypt (ใช้ตัวเดียวกับ portal)
 *   - 2FA แบบ TOTP (Google Authenticator / Microsoft Authenticator / 1Password) — RFC 6238, 30 วินาที, 6 หลัก
 *   - ล็อกบัญชี 15 นาทีเมื่อใส่รหัสผิด 5 ครั้งติด
 *   - session_version: เปลี่ยนรหัส / ปิดบัญชี / "ออกจากระบบทุกเครื่อง" → session เก่าใช้ไม่ได้ทันที
 */
const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("./portal");

const ROLES = { owner: "Owner", staff: "Staff" };
const MAX_FAILS = 5, LOCK_MINUTES = 15;
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex")); // เวลาตอบเท่ากันแม้ไม่มีชื่อผู้ใช้นี้

function normalizeUsername(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,59}$/.test(s) ? s : "";
}
function validateAdminPassword(pw, username = "") {
  if (typeof pw !== "string" || pw.length < 10) return "Password must be at least 10 characters";
  if (pw.length > 128) return "Password is too long";
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return "Password must not contain the username";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers";
  return null;
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238)
// ---------------------------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0");
}
/** คืน step ที่ตรง (ยอมคลาดเคลื่อน ±1 ช่วง = ±30 วินาที) หรือ 0 ถ้าไม่ตรง */
function checkTotp(secret, code, now = Date.now()) {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c) || !secret) return 0;
  const cur = Math.floor(now / 30000);
  for (const s of [cur, cur - 1, cur + 1]) {
    const a = Buffer.from(totpAt(secret, s)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return s;
  }
  return 0;
}
const otpauthUrl = (secret, username, issuer = "DataCorp Admin") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------
const COLS = "id, username, display_name, email, role, must_change, totp_secret IS NOT NULL AS has_2fa, is_active, last_login_at, last_login_ip, created_at";

async function count(q) { return Number((await q("SELECT COUNT(*) n FROM admin_users"))[0].n); }
async function list(q) { return q(`SELECT ${COLS} FROM admin_users ORDER BY role = 'owner' DESC, username`); }
async function get(q, id) { return (await q(`SELECT ${COLS}, session_version FROM admin_users WHERE id = ?`, [Number(id)]))[0] || null; }

async function create(q, { username, password, display_name = "", email = "", role = "staff", must_change = 1 }) {
  const u = normalizeUsername(username);
  if (!u) throw new Error("Username: 3–60 characters, lowercase letters, numbers, dot, dash or underscore");
  const err = validateAdminPassword(password, u);
  if (err) throw new Error(err);
  try {
    const r = await q("INSERT INTO admin_users (username, display_name, email, role, password_hash, must_change) VALUES (?,?,?,?,?,?)",
      [u, String(display_name).trim().slice(0, 120), String(email).trim().slice(0, 190), ROLES[role] ? role : "staff", hashPassword(password), must_change ? 1 : 0]);
    return r.insertId;
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") throw new Error(`Username "${u}" is already taken`);
    throw e;
  }
}

/**
 * ตรวจชื่อผู้ใช้ + รหัสผ่าน → { user } | { error, locked }
 * ไม่บอกว่าผิดที่ชื่อหรือรหัส; นับครั้งที่ผิดและล็อกบัญชีชั่วคราว
 */
async function authenticate(q, username, password, ip = "") {
  const u = normalizeUsername(username);
  const row = u ? (await q("SELECT *, locked_until > NOW() AS is_locked FROM admin_users WHERE username = ?", [u]))[0] : null;
  if (!row) { verifyPassword(password, DUMMY_HASH); return { error: "Incorrect username or password." }; }
  if (Number(row.is_locked)) return { error: `Too many failed attempts — this account is locked for ${LOCK_MINUTES} minutes.`, locked: true };
  if (!verifyPassword(password, row.password_hash)) {
    const fails = row.failed_logins + 1;
    if (fails >= MAX_FAILS) await q("UPDATE admin_users SET failed_logins = 0, locked_until = NOW() + INTERVAL ? MINUTE WHERE id = ?", [LOCK_MINUTES, row.id]);
    else await q("UPDATE admin_users SET failed_logins = ? WHERE id = ?", [fails, row.id]);
    return { error: fails >= MAX_FAILS ? `Too many failed attempts — this account is locked for ${LOCK_MINUTES} minutes.` : "Incorrect username or password." };
  }
  if (!row.is_active) return { error: "This account is disabled. Ask an owner to re-enable it." };
  return { user: row };
}
/** เข้าสู่ระบบสำเร็จ (หลังผ่าน 2FA ถ้ามี) */
async function recordLogin(q, id, ip) {
  await q("UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = ? WHERE id = ?", [String(ip || "").slice(0, 64), id]);
}

/** ตรวจรหัส 2FA และกันใช้รหัสเดิมซ้ำ */
async function verify2fa(q, id, code) {
  const row = (await q("SELECT totp_secret, totp_last_step FROM admin_users WHERE id = ?", [id]))[0];
  if (!row || !row.totp_secret) return false;
  const step = checkTotp(row.totp_secret, code);
  if (!step || step <= Number(row.totp_last_step)) return false;
  const r = await q("UPDATE admin_users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?", [step, id, step]);
  return r.affectedRows === 1;
}
async function enable2fa(q, id, secret, code) {
  const step = checkTotp(secret, code);
  if (!step) throw new Error("That code is not correct — check the time on your phone and try the newest code.");
  await q("UPDATE admin_users SET totp_secret = ?, totp_last_step = ? WHERE id = ?", [secret, step, id]);
}
const disable2fa = (q, id) => q("UPDATE admin_users SET totp_secret = NULL, totp_last_step = 0 WHERE id = ?", [id]);

/** เปลี่ยนรหัสผ่าน (ของตัวเองต้องใส่รหัสเดิม) — session อื่นของบัญชีนี้หลุดทั้งหมด; คืน session_version ใหม่ */
async function changePassword(q, id, { current, next, requireCurrent = true, mustChange = 0 }) {
  const row = (await q("SELECT username, password_hash FROM admin_users WHERE id = ?", [id]))[0];
  if (!row) throw new Error("Account not found");
  if (requireCurrent && !verifyPassword(current, row.password_hash)) throw new Error("Current password is incorrect");
  const err = validateAdminPassword(next, row.username);
  if (err) throw new Error(err);
  if (verifyPassword(next, row.password_hash)) throw new Error("Choose a password different from the current one");
  await q("UPDATE admin_users SET password_hash = ?, must_change = ?, session_version = session_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?",
    [hashPassword(next), mustChange ? 1 : 0, id]);
  return (await q("SELECT session_version FROM admin_users WHERE id = ?", [id]))[0].session_version;
}
async function signOutEverywhere(q, id) {
  await q("UPDATE admin_users SET session_version = session_version + 1 WHERE id = ?", [id]);
  return (await q("SELECT session_version FROM admin_users WHERE id = ?", [id]))[0].session_version;
}

/** ต้องเหลือ owner ที่ใช้งานได้อย่างน้อย 1 คนเสมอ */
async function assertOwnerRemains(q, changingId) {
  const n = Number((await q("SELECT COUNT(*) n FROM admin_users WHERE role = 'owner' AND is_active = 1 AND id <> ?", [changingId]))[0].n);
  if (!n) throw new Error("There must always be at least one active owner");
}
async function setActive(q, id, active) {
  if (!active) await assertOwnerRemains(q, id);
  await q("UPDATE admin_users SET is_active = ?, session_version = session_version + 1 WHERE id = ?", [active ? 1 : 0, id]);
}
async function setRole(q, id, role) {
  if (!ROLES[role]) throw new Error("Unknown role");
  if (role !== "owner") await assertOwnerRemains(q, id);
  await q("UPDATE admin_users SET role = ? WHERE id = ?", [role, id]);
}
async function updateProfile(q, id, { display_name, email }) {
  await q("UPDATE admin_users SET display_name = ?, email = ? WHERE id = ?", [String(display_name || "").trim().slice(0, 120), String(email || "").trim().slice(0, 190), id]);
}

module.exports = {
  ROLES, normalizeUsername, validateAdminPassword,
  newTotpSecret, checkTotp, totpAt, otpauthUrl, base32Encode, base32Decode,
  count, list, get, create, authenticate, recordLogin, verify2fa, enable2fa, disable2fa,
  changePassword, signOutEverywhere, setActive, setRole, updateProfile,
};
