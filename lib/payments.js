"use strict";
/**
 * เลือกผู้ให้บริการรับชำระเงิน (Merchant of Record) จาก env
 *   PAYMENT_PROVIDER = polar | lemonsqueezy   (ถ้าไม่ตั้ง: polar เมื่อมี POLAR_ACCESS_TOKEN, ไม่งั้น lemonsqueezy)
 * ให้ที่อื่นในระบบถามจากที่นี่ที่เดียวว่า provider ชื่ออะไร พร้อมใช้ไหม อยู่โหมดทดสอบไหม
 */
const polar = require("./polar");
const ls = require("./lemonsqueezy");

const PROVIDERS = {
  polar: {
    key: "polar",
    name: "Polar",                              // ชื่อที่แสดงให้ลูกค้า
    legalName: "Polar Software Inc.",            // ชื่อนิติบุคคล (ใช้ในหน้านโยบาย)
    buyerTermsUrl: "https://polar.sh/legal/terms",
    privacyUrl: "https://polar.sh/legal/privacy",
    webhookPath: "/webhooks/polar",
    envApi: "POLAR_ACCESS_TOKEN", envSecret: "POLAR_WEBHOOK_SECRET", envTest: "POLAR_SERVER=sandbox",
    ready: () => !!(process.env.POLAR_ACCESS_TOKEN || "").trim(),
    webhookReady: () => !!(process.env.POLAR_WEBHOOK_SECRET || "").trim(),
    testMode: () => polar.isSandbox(),
    paymentMethods: "credit/debit card",
  },
  lemonsqueezy: {
    key: "lemonsqueezy",
    name: "Lemon Squeezy",
    legalName: "Lemon Squeezy, LLC",
    buyerTermsUrl: "https://lemonsqueezy.com/buyer-terms",
    privacyUrl: "https://lemonsqueezy.com/privacy",
    webhookPath: "/webhooks/lemonsqueezy",
    envApi: "LS_API_KEY", envSecret: "LS_WEBHOOK_SECRET", envTest: "LS_TEST_MODE=true",
    ready: () => !!(process.env.LS_API_KEY || "").trim(),
    webhookReady: () => !!(process.env.LS_WEBHOOK_SECRET || "").trim(),
    testMode: () => /^(1|true|yes)$/i.test(process.env.LS_TEST_MODE || ""),
    paymentMethods: "credit/debit card or PayPal",
  },
};

function providerKey() {
  const k = (process.env.PAYMENT_PROVIDER || "").trim().toLowerCase();
  if (PROVIDERS[k]) return k;
  return (process.env.POLAR_ACCESS_TOKEN || "").trim() ? "polar" : "lemonsqueezy";
}
function provider() { return PROVIDERS[providerKey()]; }

/** ข้อมูลสำหรับ view/health (ค่าเป็น plain object) */
function info() {
  const p = provider();
  return { key: p.key, name: p.name, legalName: p.legalName, buyerTermsUrl: p.buyerTermsUrl, privacyUrl: p.privacyUrl,
           webhookPath: p.webhookPath, envApi: p.envApi, envSecret: p.envSecret, envTest: p.envTest,
           ready: p.ready(), webhookReady: p.webhookReady(), testMode: p.testMode(), paymentMethods: p.paymentMethods };
}

/**
 * สร้างลิงก์ชำระเงินของบิล 1 ใบ (ใช้ provider ที่เลือก) คืน { id, url, test_mode, provider }
 * args: { amountThb, email, name, taxNumber, country, zip, address, customerKey, custom, label, description, successUrl, portalUrl, note }
 */
async function createCheckout(a) {
  const p = provider();
  if (p.key === "polar") {
    const r = await polar.createCheckout({
      amountThb: a.amountThb, email: a.email, name: a.name, taxNumber: a.taxNumber, country: a.country, zip: a.zip, address: a.address,
      customerKey: a.customerKey, custom: a.custom, successUrl: a.successUrl,
    });
    return { ...r, provider: "polar" };
  }
  const r = await ls.createCheckout({
    amountThb: a.amountThb, email: a.email, name: a.name, taxNumber: a.taxNumber, country: a.country, zip: a.zip,
    custom: a.custom, productName: a.label, productDescription: a.description, redirectUrl: a.successUrl,
    receiptButtonText: "Open customer portal", receiptLinkUrl: a.portalUrl, receiptNote: a.note, testMode: p.testMode(),
  });
  return { ...r, provider: "lemonsqueezy" };
}

module.exports = { providerKey, provider, info, createCheckout, PROVIDERS };
