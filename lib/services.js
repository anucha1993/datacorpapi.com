"use strict";
/**
 * Sellable services catalog — admin manages, customers buy from the portal.
 * A "buy" creates a normal manual invoice (see lib/invoices.js createManualInvoice) and sends the
 * customer either to the service's pasted Polar checkout link, or to a fixed-price checkout made via the API.
 * Either way the existing webhook marks the invoice paid and fetches the receipt.
 */
const money = (v) => Math.round(Number(v || 0) * 100) / 100;

async function listActive(q) {
  return q("SELECT * FROM service_catalog WHERE is_active = 1 ORDER BY sort_order, name");
}
async function listAll(q) {
  return q(`SELECT s.*, (SELECT COUNT(*) FROM billing_invoices i WHERE i.service_id = s.id AND i.status = 'paid') sold,
                  (SELECT COALESCE(SUM(amount_thb),0) FROM billing_invoices i WHERE i.service_id = s.id AND i.status = 'paid') revenue
           FROM service_catalog s ORDER BY s.sort_order, s.name`);
}
async function get(q, id) {
  const rows = await q("SELECT * FROM service_catalog WHERE id = ? LIMIT 1", [Number(id)]);
  return rows[0] || null;
}

/** Polar checkout links: https://buy.polar.sh/polar_cl_… (production) or sandbox-… — any https URL is accepted */
function cleanLink(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { throw new Error("Payment link must be a full URL, e.g. https://buy.polar.sh/polar_cl_…"); }
  if (u.protocol !== "https:") throw new Error("Payment link must start with https://");
  return u.toString().slice(0, 700);
}
function clean({ name, description, price_thb, payment_link, sort_order, minThb }) {
  const n = String(name || "").trim().slice(0, 190);
  if (!n) throw new Error("Name is required");
  const price = money(price_thb);
  if (!(price >= minThb)) throw new Error(`Price must be at least ฿${minThb}`);
  return [n, String(description || "").trim().slice(0, 1000), price, cleanLink(payment_link), Math.trunc(Number(sort_order) || 0)];
}
async function create(q, data) {
  await q("INSERT INTO service_catalog (name, description, price_thb, payment_link, sort_order) VALUES (?,?,?,?,?)", clean(data));
}
async function update(q, id, data) {
  await q("UPDATE service_catalog SET name = ?, description = ?, price_thb = ?, payment_link = ?, sort_order = ? WHERE id = ?", [...clean(data), Number(id)]);
}
async function toggle(q, id) {
  await q("UPDATE service_catalog SET is_active = 1 - is_active WHERE id = ?", [Number(id)]);
}
async function remove(q, id) {
  await q("DELETE FROM service_catalog WHERE id = ?", [Number(id)]);
}

/**
 * Pasted checkout link + per-invoice prefill. reference_id is copied by Polar into the checkout
 * session/order metadata, which is how the webhook finds the invoice (see invoices.applyPolarOrder).
 */
function linkForInvoice(link, inv, { email = "", name = "" } = {}) {
  const u = new URL(link);
  u.searchParams.set("reference_id", inv.invoice_no);
  if (email) u.searchParams.set("customer_email", email);
  if (name) u.searchParams.set("customer_name", name);
  return u.toString();
}

module.exports = { listActive, listAll, get, create, update, toggle, remove, linkForInvoice };
