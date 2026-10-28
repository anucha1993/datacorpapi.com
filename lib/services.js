"use strict";
/**
 * Sellable services catalog — admin manages, customers buy from the portal.
 * A "buy" simply creates a normal manual invoice (see lib/invoices.js createManualInvoice),
 * reusing the existing Polar/Lemon Squeezy checkout + webhook + receipt pipeline.
 */
const money = (v) => Math.round(Number(v || 0) * 100) / 100;

async function listActive(q) {
  return q("SELECT * FROM service_catalog WHERE is_active = 1 ORDER BY sort_order, name");
}
async function listAll(q) {
  return q("SELECT * FROM service_catalog ORDER BY sort_order, name");
}
async function get(q, id) {
  const rows = await q("SELECT * FROM service_catalog WHERE id = ? LIMIT 1", [Number(id)]);
  return rows[0] || null;
}
async function create(q, { name, description, price_thb, minThb }) {
  const n = String(name || "").trim().slice(0, 190);
  if (!n) throw new Error("Name is required");
  const price = money(price_thb);
  if (!(price >= minThb)) throw new Error(`Price must be at least ฿${minThb}`);
  await q("INSERT INTO service_catalog (name, description, price_thb) VALUES (?,?,?)",
    [n, String(description || "").trim().slice(0, 1000), price]);
}
async function update(q, id, { name, description, price_thb, minThb }) {
  const n = String(name || "").trim().slice(0, 190);
  if (!n) throw new Error("Name is required");
  const price = money(price_thb);
  if (!(price >= minThb)) throw new Error(`Price must be at least ฿${minThb}`);
  await q("UPDATE service_catalog SET name = ?, description = ?, price_thb = ? WHERE id = ?",
    [n, String(description || "").trim().slice(0, 1000), price, Number(id)]);
}
async function toggle(q, id) {
  await q("UPDATE service_catalog SET is_active = 1 - is_active WHERE id = ?", [Number(id)]);
}
async function remove(q, id) {
  await q("DELETE FROM service_catalog WHERE id = ?", [Number(id)]);
}

module.exports = { listActive, listAll, get, create, update, toggle, remove };
