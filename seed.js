#!/usr/bin/env node
/**
 * ใส่ข้อมูลตัวอย่าง (demo) ลงฐานข้อมูล เพื่อดูหน้าเว็บ/หลังบ้านก่อนมีข้อมูลจริง
 *   node seed.js          → สินค้าตัวอย่าง 2 ตัว (API + License) พร้อมแพ็กเกจ, ลูกค้า demo-acme (รหัส demo1234), subscription, key, ยอดใช้งาน
 *   node seed.js --clean  → ลบข้อมูลตัวอย่างทั้งหมดออก (เฉพาะแถวที่ seed ใส่)
 * ข้อมูลตัวอย่างทุกแถวมีเครื่องหมาย: slug ขึ้นต้น "demo-", operator ขึ้นต้น "demo-"
 */
"use strict";
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const mysql = require("mysql2/promise");
const portal = require("./lib/portal");
const platform = require("./lib/platform");

const PRODUCTS = [
  { slug: "demo-ocr-api", name: "OCR API (demo)", kind: "api", unit_label: "pages", tagline: "Extract text from Thai & English documents",
    plans: [
      { name: "Free", billing: "month", price_thb: 0, included_units: 100, unit_price_thb: 0, max_keys: 1, rate_limit_per_min: 10, features: "Community support" },
      { name: "Pro", billing: "month", price_thb: 490, included_units: 5000, unit_price_thb: 0.2, max_keys: 5, rate_limit_per_min: 120, features: "Email support\nOverage ฿0.20 / page", polar_product_id: "demo-polar-pro", is_featured: 1 },
      { name: "Pay as you go", billing: "usage", price_thb: 0, included_units: 0, unit_price_thb: 0.35, max_keys: 5, features: "No monthly fee" },
    ] },
  { slug: "demo-desktop", name: "Desktop Pro (demo)", kind: "license", unit_label: "activations", tagline: "Licensed desktop app for your team",
    plans: [
      { name: "Monthly", billing: "month", price_thb: 290, included_units: null, max_keys: 1, max_devices: 2, polar_product_id: "demo-polar-desk-m" },
      { name: "Yearly", billing: "year", price_thb: 2900, included_units: null, max_keys: 1, max_devices: 3, polar_product_id: "demo-polar-desk-y", is_featured: 1, features: "2 months free" },
    ] },
];

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || "ewp_usage", user: process.env.DB_USER || "ewp_web",
    password: process.env.DB_PASSWORD || "", charset: "utf8mb4", timezone: "+07:00", dateStrings: true,
  });
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];
  try {
    const demoSubs = "SELECT id FROM subscriptions WHERE operator LIKE 'demo-%'";
    await q(`DELETE FROM usage_counters WHERE subscription_id IN (SELECT id FROM (${demoSubs}) x)`);
    await q("DELETE d FROM key_devices d JOIN access_keys k ON k.id = d.key_id WHERE k.operator LIKE 'demo-%'");
    await q("DELETE FROM access_keys WHERE operator LIKE 'demo-%'");
    await q("DELETE FROM billing_invoices WHERE operator LIKE 'demo-%'");
    await q("DELETE FROM subscriptions WHERE operator LIKE 'demo-%'");
    await q("DELETE pl FROM product_plans pl JOIN products p ON p.id = pl.product_id WHERE p.slug LIKE 'demo-%'");
    await q("DELETE FROM products WHERE slug LIKE 'demo-%'");
    await q("DELETE FROM portal_users WHERE operator LIKE 'demo-%'");
    if (process.argv.includes("--clean")) { console.log("✓ ลบข้อมูลตัวอย่างแล้ว"); return; }

    const planIds = {};
    for (const [i, p] of PRODUCTS.entries()) {
      const id = await platform.saveProduct(q, null, { ...p, sort_order: i });
      for (const [j, pl] of p.plans.entries()) {
        await platform.savePlan(q, id, null, { ...pl, included_units: pl.included_units == null ? "" : pl.included_units, sort_order: j }, 0);
        planIds[`${p.slug}/${pl.name}`] = (await q("SELECT id FROM product_plans WHERE product_id = ? AND name = ?", [id, pl.name]))[0].id;
      }
    }
    await portal.createUser(q, { operator: "demo-acme", password: "demo1234", display_name: "Acme Demo", email: "acc@example.com" });
    await q("UPDATE portal_users SET company_name = 'Acme Demo Co., Ltd.', tax_id = '0105500000000', address = '1 Demo Rd, Bangkok', zip = '10110', billing_email = 'acc@example.com' WHERE operator = 'demo-acme'");

    const ym = new Date().toISOString().slice(0, 7);
    const pro = await platform.getPlan(q, planIds["demo-ocr-api/Pro"]);
    const s1 = await platform.createSubscription(q, "demo-acme", pro, { source: "manual", months: 1, note: "seed" });
    await q("INSERT INTO usage_counters (subscription_id, ym, units, requests) VALUES (?,?,?,?)", [s1, ym, 4120, 3980]);
    const apiKey = await platform.createKey(q, await platform.getSubscription(q, s1), "Production server");
    const desk = await platform.getPlan(q, planIds["demo-desktop/Yearly"]);
    const s2 = await platform.createSubscription(q, "demo-acme", desk, { source: "manual", months: 12, note: "seed" });
    const licKey = await platform.createKey(q, await platform.getSubscription(q, s2), "Office PC");

    console.log("✓ ใส่ข้อมูลตัวอย่างแล้ว");
    console.log("  portal: demo-acme / demo1234");
    console.log("  API key:     " + apiKey);
    console.log("  License key: " + licKey);
    console.log("ลบข้อมูลตัวอย่างออกได้ด้วย: node seed.js --clean");
  } catch (e) {
    console.error("✗", e.code || "", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
