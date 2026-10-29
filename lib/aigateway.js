"use strict";
/**
 * AI gateway แบบเดียวกับ OpenAI API — ลูกค้าใช้ OpenAI SDK ได้เลย แค่เปลี่ยน base_url + ใช้ key ของ DataCorp
 *   ลูกค้า ──dca_sk_…──▶ /v1/chat/completions ──OPENAI_API_KEY ของเรา──▶ OpenAI
 * ตรวจ key/แพ็กเกจ/โควตา → จำกัดโมเดลและ max tokens ตามแพ็กเกจ → ส่งต่อ → นับ credits จาก usage จริง
 *
 * 1 credit = ฿0.001 ของต้นทุน OpenAI (คิดจากราคาในตาราง ai_models × AI_USD_THB)
 * key ของ OpenAI ไม่เคยถูกส่งกลับไปหาลูกค้า และ error จาก OpenAI ที่เกี่ยวกับบัญชีเราจะถูกแทนด้วยข้อความกลาง ๆ
 */
const platform = require("./platform");
const secretbox = require("./secretbox");

const cfg = () => ({
  key: (process.env.OPENAI_API_KEY || "").trim(),
  base: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, ""),
  slug: (process.env.AI_PRODUCT_SLUG || "ai-api").trim(),
  fx: Number(process.env.AI_USD_THB) > 0 ? Number(process.env.AI_USD_THB) : 36,
});
const CREDITS_PER_THB = 1000;

// ---------------------------------------------------------------------------
// model price list (cache 60 วินาที — แก้ในแอดมินแล้วมีผลภายในนาที)
// ---------------------------------------------------------------------------
let cache = { at: 0, rows: [] };
async function models(q, { fresh = false } = {}) {
  if (fresh || Date.now() - cache.at > 60000) cache = { at: Date.now(), rows: await q("SELECT * FROM ai_models ORDER BY sort_order, model") };
  return cache.rows;
}
const clearCache = () => { cache.at = 0; };

/** credits ต่อ 1K tokens (ไว้แสดงให้ลูกค้าดู) */
function rates(m, fx = cfg().fx) {
  const per1k = (usd) => Math.round(Number(usd) / 1000 * fx * CREDITS_PER_THB * 100) / 100;
  return { input: per1k(m.input_usd_per_1m), output: per1k(m.output_usd_per_1m),
    perUnit: Math.round(Number(m.input_usd_per_1m) / 1e6 * fx * CREDITS_PER_THB * 100) / 100 }; // OCR: credits ต่อหน้า
}
function credits(m, promptTokens, completionTokens, fx = cfg().fx) {
  const usd = (Number(promptTokens) * Number(m.input_usd_per_1m) + Number(completionTokens) * Number(m.output_usd_per_1m)) / 1e6;
  return Math.max(1, Math.ceil(usd * fx * CREDITS_PER_THB));
}
const allowedList = (plan) => String(plan.allowed_models || "").split(",").map(s => s.trim()).filter(Boolean);
/** โมเดลที่แพ็กเกจนี้ใช้ได้ (active + อยู่ใน allowed_models ถ้ากำหนด) */
async function modelsForPlan(q, plan, kind = "chat") {
  const allow = allowedList(plan);
  return (await models(q)).filter(m => m.is_active && (m.kind || "chat") === kind && (!allow.length || allow.includes(m.model)));
}
const VISION_MODEL = "google-vision-ocr";

async function saveModel(q, id, d) {
  const model = String(d.model || "").trim().slice(0, 100);
  if (!/^[A-Za-z0-9._:\/-]+$/.test(model)) throw new Error("Model ID is required (exact OpenAI model name, e.g. gpt-4o-mini)");
  const inp = Number(d.input_usd_per_1m), out = Number(d.output_usd_per_1m);
  if (!(inp >= 0) || !(out >= 0) || inp + out <= 0) throw new Error("Enter the OpenAI input and output price (USD per 1M tokens)");
  const row = [model, String(d.label || "").trim().slice(0, 120) || model, inp, out, Math.trunc(Number(d.sort_order) || 0)];
  try {
    if (id) await q("UPDATE ai_models SET model=?, label=?, input_usd_per_1m=?, output_usd_per_1m=?, sort_order=? WHERE id=?", [...row, id]);
    else await q("INSERT INTO ai_models (model, label, input_usd_per_1m, output_usd_per_1m, sort_order) VALUES (?,?,?,?,?)", row);
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") throw new Error(`Model "${model}" is already in the list`);
    throw e;
  }
  clearCache();
}

// ---------------------------------------------------------------------------
// OpenAI key รายลูกค้า (เช่น Project แยกต่อลูกค้า) — ไม่ได้ตั้ง = ใช้ OPENAI_API_KEY ใน .env
// ---------------------------------------------------------------------------
const keyCache = new Map(); // operator → { at, key }
/** key ของลูกค้า | null (ไม่ได้ตั้ง → ใช้ key กลาง) | false (ตั้งไว้แต่ถอดรหัสไม่ได้) */
async function customerKey(q, operator) {
  const hit = keyCache.get(operator);
  if (hit && Date.now() - hit.at < 60000) return hit.key;
  const row = (await q("SELECT openai_key_enc FROM portal_users WHERE operator = ? LIMIT 1", [operator]).catch(e => { if (e.code === "ER_BAD_FIELD_ERROR") return []; throw e; }))[0];
  const key = row && row.openai_key_enc ? (secretbox.decrypt(row.openai_key_enc) || false) : null;
  keyCache.set(operator, { at: Date.now(), key });
  return key;
}
const forgetCustomerKey = (operator) => keyCache.delete(operator);

/** บันทึก/ลบ key ของลูกค้า (ว่าง = ลบ → กลับไปใช้ key กลาง) */
async function setCustomerKey(q, operator, value) {
  const v = String(value || "").trim();
  if (v && !/^sk-[A-Za-z0-9_\-]{20,}$/.test(v)) throw new Error("That does not look like an OpenAI API key (starts with sk-)");
  await q("UPDATE portal_users SET openai_key_enc = ?, openai_key_hint = ?, openai_key_set_at = ? WHERE operator = ?",
    v ? [secretbox.encrypt(v), secretbox.hint(v), new Date(), operator] : [null, "", null, operator]);
  forgetCustomerKey(operator);
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------
const oaiError = (res, status, message, code, type = "invalid_request_error", extra = {}) =>
  res.status(status).json({ error: { message, type, code, param: null, ...extra } });

/** server.js ตั้งค่า: (rawKey, error) → ลิงก์จ่าย/อัปเกรดที่โปรแกรมของลูกค้าเปิดได้ทันที (lib/paylinks.js) */
let payLink = null;
const setPayLink = (fn) => { payLink = fn; };
async function blockedError(res, rawKey, status, message, code, type) {
  let url = null;
  if (payLink) { try { url = await payLink(rawKey, code); } catch (e) { console.error("[ai] pay link:", e.message); } }
  return oaiError(res, status, url ? `${message} — ${url}` : message, code, type, url ? { action_url: url } : {});
}
const rawKeyOf = (req) => String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() || String(req.get("x-api-key") || "").trim();

const ERR_TYPE = { 401: "authentication_error", 402: "insufficient_quota", 403: "permission_error", 429: "rate_limit_error" };

async function authKey(q, req, res) {
  const c = cfg();
  const product = (await q("SELECT * FROM products WHERE slug = ? LIMIT 1", [c.slug]))[0];
  if (!product) { oaiError(res, 503, "AI service is not configured", "service_unavailable", "server_error"); return null; }
  const raw = rawKeyOf(req);
  const r = await platform.resolveKey(q, raw, { kind: "api", productId: product.id });
  if (!r.ok) {
    const msg = r.error === "wrong_product" ? "This API key is for a different DataCorp product" : r.message;
    if (r.error === "inactive" || r.error === "payment_required") await blockedError(res, raw, r.status, msg, r.error, ERR_TYPE[r.status] || "invalid_request_error");
    else oaiError(res, r.status, msg, r.error, ERR_TYPE[r.status] || "invalid_request_error");
    return null;
  }
  return r.sub;
}

/** GET /v1/models */
async function listModels(q, req, res) {
  const sub = await authKey(q, req, res);
  if (!sub) return;
  const list = await modelsForPlan(q, sub);
  res.json({ object: "list", data: list.map(m => ({ id: m.model, object: "model", created: Math.floor(new Date(m.created_at).getTime() / 1000) || 0, owned_by: "datacorp" })) });
}

/** โควตา (แพ็กเกจที่ไม่คิดเงินส่วนเกิน = หยุดเมื่อครบ) — ตอบ 429 แล้วคืน true */
async function quotaBlocked(q, req, res, sub) {
  const used = Number(((await q("SELECT units FROM usage_counters WHERE subscription_id = ? AND ym = ?", [sub.id, platform.ymNow()]))[0] || {}).units || 0);
  const included = sub.included_units == null ? null : Number(sub.included_units);
  if (included == null || Number(sub.unit_price_thb) > 0 || used < included) return false;
  await blockedError(res, rawKeyOf(req), 429, `Monthly quota of ${included.toLocaleString("en-US")} credits reached — resets on the ${platform.cycleLabel()}, or upgrade your plan`, "quota_exceeded", "insufficient_quota");
  return true;
}

/** ประมาณ tokens เมื่อไม่ได้ usage จาก OpenAI (เช่นลูกค้าตัดการเชื่อมต่อกลางสตรีม) — ปัดขึ้นเสมอ */
const estTokens = (s) => Math.ceil(String(s || "").length / 3);

/** POST /v1/chat/completions */
async function chatCompletions(q, req, res) {
  const c = cfg();
  const sub = await authKey(q, req, res);
  if (!sub) return;
  if (!platform.rateOk(sub.key_id, Number(sub.rate_limit_per_min)))
    return oaiError(res, 429, `Rate limit is ${sub.rate_limit_per_min} requests per minute per key`, "rate_limited", "rate_limit_error");

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? { ...req.body } : null;
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return oaiError(res, 400, "messages is required", "invalid_request");
  const allowed = await modelsForPlan(q, sub);
  const model = allowed.find(m => m.model === String(body.model || ""));
  if (!model) return oaiError(res, 400, `Model "${body.model || ""}" is not available on your ${sub.plan_name} plan. Available: ${allowed.map(m => m.model).join(", ") || "none"}`, "model_not_available");

  if (await quotaBlocked(q, req, res, sub)) return;
  const own = await customerKey(q, sub.operator);
  if (own === false) {
    console.error(`[ai] OpenAI key of ${sub.operator} cannot be decrypted (DATA_ENCRYPTION_KEY / .data-key changed?) — re-enter it in Admin → Customers`);
    return oaiError(res, 503, "AI service is temporarily unavailable", "service_unavailable", "server_error");
  }
  const upstreamKey = own || c.key;
  if (!upstreamKey) return oaiError(res, 503, "AI service is temporarily unavailable", "service_unavailable", "server_error");

  // จำกัด output ต่อ request ตามแพ็กเกจ
  const cap = Number(sub.max_output_tokens) || 0;
  if (cap) {
    if (body.max_tokens != null) body.max_tokens = Math.min(cap, Math.max(1, Math.trunc(Number(body.max_tokens)) || cap));
    else body.max_completion_tokens = Math.min(cap, Math.max(1, Math.trunc(Number(body.max_completion_tokens)) || cap));
  }
  const n = Math.trunc(Number(body.n) || 1);
  if (n > 4) return oaiError(res, 400, "n must be 4 or less", "invalid_request");
  body.user = "dc_" + platform.sha256(sub.operator).slice(0, 24); // ให้ OpenAI แยกผู้ใช้ได้ โดยไม่ส่งตัวตนจริง
  const stream = !!body.stream;
  const wantUsage = !!(body.stream_options && body.stream_options.include_usage);
  if (stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10 * 60 * 1000);
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  let pt = 0, ct = 0, gotUsage = false, streamedText = "";
  const charge = async () => {
    if (!gotUsage) { pt = estTokens(JSON.stringify(body.messages)); ct = estTokens(streamedText); }
    const cr = credits(model, pt, ct, c.fx);
    await platform.addUsage(q, sub.id, sub.key_id, cr);
    return cr;
  };

  let up;
  try {
    up = await fetch(c.base + "/chat/completions", {
      method: "POST", signal: ac.signal,
      headers: { Authorization: "Bearer " + upstreamKey, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    clearTimeout(timer);
    if (ac.signal.aborted && res.writableEnded === false && res.destroyed) return;
    console.error("[ai] upstream fetch failed:", (e.cause && e.cause.code) || e.message);
    return oaiError(res, 502, "Could not reach the AI provider — please retry", "upstream_unavailable", "server_error");
  }

  if (!up.ok) {
    clearTimeout(timer);
    const text = await up.text().catch(() => "");
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    console.error("[ai] upstream", up.status, text.slice(0, 300));
    // ปัญหาบัญชีของเรา (key ผิด/เครดิต OpenAI หมด/โดนจำกัด) → ไม่บอกรายละเอียดลูกค้า
    if (up.status === 401 || up.status === 403) return oaiError(res, 503, "AI service is temporarily unavailable", "service_unavailable", "server_error");
    if (up.status === 429) return oaiError(res, 503, "AI service is busy — please retry shortly", "upstream_busy", "server_error");
    if (up.status === 400 || up.status === 404 || up.status === 413 || up.status === 422)
      return res.status(up.status === 404 ? 400 : up.status).json(j && j.error ? { error: j.error } : { error: { message: "The AI provider rejected the request", type: "invalid_request_error", code: "upstream_rejected", param: null } });
    return oaiError(res, 502, "The AI provider returned an error — please retry", "upstream_error", "server_error");
  }

  if (!stream) {
    let j;
    try { j = await up.json(); } catch { clearTimeout(timer); return oaiError(res, 502, "Invalid response from the AI provider", "upstream_error", "server_error"); }
    clearTimeout(timer);
    if (j.usage) { pt = Number(j.usage.prompt_tokens) || 0; ct = Number(j.usage.completion_tokens) || 0; gotUsage = true; }
    else streamedText = (j.choices || []).map(ch => (ch.message && ch.message.content) || "").join("");
    const cr = await charge();
    res.set("X-DataCorp-Credits", String(cr));
    return res.json(j);
  }

  // streaming (SSE): ส่งต่อทีละ event + อ่าน usage จาก chunk สุดท้าย
  res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const dec = new TextDecoder();
  let buf = "";
  const handleEvent = (ev) => {
    let forward = true;
    for (const line of ev.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        for (const ch of j.choices || []) if (ch.delta) streamedText += (ch.delta.content || "") + (ch.delta.refusal || "");
        if (j.usage) {
          pt = Number(j.usage.prompt_tokens) || 0; ct = Number(j.usage.completion_tokens) || 0; gotUsage = true;
          if (!wantUsage && !(j.choices || []).length) forward = false; // ลูกค้าไม่ได้ขอ usage chunk
        }
      } catch { /* ส่งต่อตามเดิม */ }
    }
    if (forward) res.write(ev + "\n\n");
  };
  try {
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { handleEvent(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (buf.trim()) handleEvent(buf.trim());
  } catch (e) {
    if (!ac.signal.aborted) console.error("[ai] stream error:", e.message);
  } finally {
    clearTimeout(timer);
    try { await charge(); } catch (e) { console.error("[ai] charge failed:", e.message); }
    if (!res.writableEnded) res.end();
  }
}

/**
 * POST /v1/vision/images:annotate · /v1/vision/files:annotate — OCR ด้วย Google Vision (body รูปแบบเดียวกับ Google)
 * ใช้ API key ของ DataCorp, แพ็กเกจต้องมีโมเดล google-vision-ocr (allowed_models ว่าง = ได้ทุกตัว), คิด credits ต่อหน้า/รูป
 */
async function vision(q, req, res, op) {
  const c = cfg();
  const sub = await authKey(q, req, res);
  if (!sub) return;
  if (!platform.rateOk(sub.key_id, Number(sub.rate_limit_per_min)))
    return oaiError(res, 429, `Rate limit is ${sub.rate_limit_per_min} requests per minute per key`, "rate_limited", "rate_limit_error");
  const reqs = req.body && Array.isArray(req.body.requests) ? req.body.requests : null;
  if (!reqs || !reqs.length) return oaiError(res, 400, "requests is required (Google Vision request format)", "invalid_request");
  if (reqs.length > 16) return oaiError(res, 400, "At most 16 requests per call", "invalid_request");
  const model = (await modelsForPlan(q, sub, "ocr")).find(m => m.model === VISION_MODEL);
  if (!model) return oaiError(res, 403, `OCR (Google Vision) is not included in your ${sub.plan_name} plan — upgrade to use it`, "feature_not_available", "permission_error");
  if (await quotaBlocked(q, req, res, sub)) return;
  const gkey = (process.env.GOOGLE_VISION_API_KEY || "").trim();
  if (!gkey) return oaiError(res, 503, "OCR service is temporarily unavailable", "service_unavailable", "server_error");
  const base = (process.env.GOOGLE_VISION_BASE_URL || "https://vision.googleapis.com/v1").trim().replace(/\/+$/, "");

  let up;
  try {
    up = await fetch(`${base}/${op}:annotate?key=${encodeURIComponent(gkey)}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: reqs }), signal: AbortSignal.timeout(180000) });
  } catch (e) {
    console.error("[ocr] upstream fetch failed:", (e.cause && e.cause.code) || e.message);
    return oaiError(res, 502, "Could not reach the OCR provider — please retry", "upstream_unavailable", "server_error");
  }
  const text = await up.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  if (!up.ok || !j) {
    console.error("[ocr] upstream", up.status, text.slice(0, 300));
    if (up.status === 400 && j && j.error) return oaiError(res, 400, String(j.error.message || "The OCR provider rejected the request"), "upstream_rejected");
    if (up.status === 429) return oaiError(res, 503, "OCR service is busy — please retry shortly", "upstream_busy", "server_error");
    return oaiError(res, up.status === 401 || up.status === 403 ? 503 : 502, "OCR service is temporarily unavailable", "upstream_error", "server_error");
  }
  // Google คิดต่อหน้า/รูป × feature — นับเฉพาะที่สำเร็จ
  const feat = (r) => Math.max(1, ((r && r.features) || []).length);
  const resp = Array.isArray(j.responses) ? j.responses : [];
  const units = op === "images"
    ? resp.reduce((t, r, i) => t + (r && !r.error ? feat(reqs[i]) : 0), 0)
    : resp.reduce((t, fr, i) => t + (fr && !fr.error ? (fr.responses || []).filter(p => p && !p.error).length * feat(reqs[i]) : 0), 0);
  const cr = units ? credits(model, units, 0, c.fx) : 0;
  if (cr) await platform.addUsage(q, sub.id, sub.key_id, cr);
  res.set({ "X-DataCorp-Credits": String(cr), "X-DataCorp-Pages": String(units) });
  res.json(j);
}

/** ตรวจว่าเซิร์ฟเวอร์ต่อ OpenAI ได้และ key ใช้ได้ (ใช้ในแอดมิน/diag) */
async function upstreamStatus(keyOverride = null) {
  const c = cfg(), k = keyOverride || c.key;
  if (!k) return { ok: false, message: "OPENAI_API_KEY is not set" };
  try {
    const r = await fetch(c.base + "/models", { headers: { Authorization: "Bearer " + k }, signal: AbortSignal.timeout(15000) });
    if (r.ok) { const j = await r.json(); return { ok: true, message: `Connected (${(j.data || []).length} models on the account)`, ids: (j.data || []).map(m => m.id) }; }
    return { ok: false, message: `OpenAI answered ${r.status}${r.status === 401 ? " — the key is wrong or revoked" : ""}` };
  } catch (e) { const x = e.cause || e; return { ok: false, message: `Cannot reach ${c.base}: ${x.code || x.name} ${x.message}` }; }
}

module.exports = { vision, VISION_MODEL, customerKey, setCustomerKey, forgetCustomerKey, setPayLink, cfg, CREDITS_PER_THB, models, rates, credits, modelsForPlan, allowedList, saveModel, clearCache, listModels, chatCompletions, upstreamStatus };
