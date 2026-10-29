"use strict";
/**
 * เข้ารหัสค่าลับที่เก็บในฐานข้อมูล (เช่น OpenAI key รายลูกค้า) ด้วย AES-256-GCM
 * กุญแจ: DATA_ENCRYPTION_KEY ใน .env (สุ่ม ≥ 32 ตัว) — ต้องเป็นค่าเดียวกันทุกที่ที่ใช้ฐานข้อมูลนี้ (เครื่องเราและเซิร์ฟเวอร์)
 * ถ้าเปลี่ยน/หาย ค่าที่เข้ารหัสไว้จะอ่านไม่ได้ → ต้องใส่ key ใหม่ในหลังบ้าน
 */
const crypto = require("crypto");

const raw = () => (process.env.DATA_ENCRYPTION_KEY || "").trim();
const ready = () => raw().length >= 32;
const key = () => crypto.createHash("sha256").update(raw()).digest();

/** → "v1:<iv>:<tag>:<ciphertext>" (base64url) */
function encrypt(plain) {
  if (!ready()) throw new Error("Set DATA_ENCRYPTION_KEY (32+ random characters) in .env first — the same value on every server that uses this database");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}
/** คืนค่าเดิม หรือ null ถ้าถอดไม่ได้ (ไม่ได้ตั้ง/กุญแจเปลี่ยน/ข้อมูลเสีย) */
function decrypt(box) {
  if (!ready()) return null;
  try {
    const [v, iv, tag, data] = String(box || "").split(":");
    if (v !== "v1") return null;
    const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
  } catch { return null; }
}
/** แสดงในหน้าจอแบบไม่เปิดเผยทั้งหมด: sk-proj-Ydh…W8A */
const hint = (s) => { s = String(s || ""); return s.length > 14 ? `${s.slice(0, 11)}…${s.slice(-4)}` : "…"; };

module.exports = { encrypt, decrypt, hint, ready };
