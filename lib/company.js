"use strict";
/** ข้อมูลธุรกิจที่ต้องแสดงบนเว็บ (ตามข้อกำหนดของผู้ให้บริการรับชำระเงิน) — อ่านจาก .env */
const KEYS = {
  COMPANY_NAME: "ชื่อผู้ขาย/แบรนด์ (บุคคลธรรมดาใช้ชื่อแบรนด์ได้)",
  COMPANY_ADDRESS: "ที่อยู่ติดต่อ",
  COMPANY_EMAIL: "อีเมลติดต่อ/ซัพพอร์ต",
  SITE_URL: "URL ของเว็บไซต์ (เช่น https://ewp.example.com)",
};
const OPTIONAL = { COMPANY_NAME_EN: "ชื่อผู้ขาย (อังกฤษ)", COMPANY_TAX_ID: "เลขประจำตัวผู้เสียภาษี", COMPANY_PHONE: "เบอร์โทรศัพท์ (ไม่บังคับ)", COMPANY_LINE: "LINE ID", SUPPORT_HOURS: "เวลาทำการซัพพอร์ต", PRODUCT_NAME: "ชื่อผลิตภัณฑ์" };

function company() {
  const c = {};
  for (const k of Object.keys({ ...KEYS, ...OPTIONAL })) c[k] = (process.env[k] || "").trim();
  // ชื่อแบรนด์เก่า (e-WorkPermit Tools) ใน .env ของเซิร์ฟเวอร์ถือว่าไม่ได้ตั้ง → ใช้ชื่อใหม่แทน
  if (/workpermit/i.test(c.PRODUCT_NAME)) c.PRODUCT_NAME = "";
  c.PRODUCT_NAME = c.PRODUCT_NAME || "DataCorp API";
  c.SUPPORT_HOURS = c.SUPPORT_HOURS || "Mon–Fri 09:00–18:00 (Bangkok time, UTC+7)";
  c.SITE_URL = c.SITE_URL.replace(/\/+$/, "");
  c.missing = Object.keys(KEYS).filter(k => !c[k] || /CHANGE_ME/i.test(c[k]));
  c.isComplete = c.missing.length === 0;
  c.EFFECTIVE_DATE = (process.env.POLICY_EFFECTIVE_DATE || "").trim() || "2026-10-21";
  c.PAY = require("./payments").info();  // ผู้ให้บริการรับชำระเงิน (ชื่อ/ลิงก์นโยบาย) สำหรับหน้าเว็บ
  return c;
}

module.exports = { company, KEYS };
