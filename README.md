# DataCorp API — แพลตฟอร์มขาย API Key / License Key (แบบ GitHub Copilot)

Node.js (Express + EJS) + MariaDB/MySQL ในแอปเดียว

| ส่วน | URL | ใครเข้า |
|---|---|---|
| **หน้าเว็บสาธารณะ** สินค้า · ราคา (ดึงแพ็กเกจจากฐานข้อมูล) · ข้อกำหนด · คืนเงิน · ความเป็นส่วนตัว · ติดต่อ | `/` `/pricing` `/terms` `/refund` `/privacy` `/contact` | ทุกคน (ผู้ตรวจของผู้ให้บริการรับชำระเงินด้วย) |
| **Customer Portal** แพ็กเกจที่ใช้ · โควตาเดือนนี้ · สร้าง/ยกเลิก API key และ License key · เปลี่ยน/ยกเลิกแพ็กเกจ · ใบแจ้งหนี้ + ใบเสร็จ · ซื้อบริการครั้งเดียว | `/portal` | ลูกค้า |
| **หลังบ้าน** ภาพรวม (MRR/รายได้/ค้างชำระ) · สินค้า + แพ็กเกจ · subscription · ลูกค้า · ใบแจ้งหนี้ · บริการครั้งเดียว | `/admin` (รหัสผ่าน) | คุณ |
| **Platform API** ตรวจ key + นับโควตา · ตรวจ license + ผูกเครื่อง · ลูกค้าดูโควตาตัวเอง | `/api/v1/*` | backend ของบริการ / โปรแกรมของลูกค้า |
| **SN ของบัญชี** (โปรแกรมเดิมยังใช้) | `POST /api/license/verify` | โปรแกรมเดิม |
| **Webhook** Polar: order + subscription | `/webhooks/polar` | Polar |

## 1. ฐานข้อมูล
ติดตั้งใหม่: สร้าง database + user ผ่านหน้าควบคุมของโฮสต์ แล้วรันตามลำดับ (phpMyAdmin → SQL หรือ):
```bash
mysql -h HOST -u USER -p DATABASE < sql/portal_schema.sql      # บัญชีลูกค้า
mysql -h HOST -u USER -p DATABASE < sql/license_schema.sql     # SN ของบัญชี + เครื่องที่ตรวจ
mysql -h HOST -u USER -p DATABASE < sql/billing_schema.sql     # webhook/คำสั่งซื้อ + ข้อความติดต่อ
mysql -h HOST -u USER -p DATABASE < sql/invoice_schema.sql     # ใบแจ้งหนี้ + ข้อมูลออกใบเสร็จ
mysql -h HOST -u USER -p DATABASE < sql/invoice_manual.sql     # บิลระบุยอดเอง
mysql -h HOST -u USER -p DATABASE < sql/polar_schema.sql       # Polar order/receipt
mysql -h HOST -u USER -p DATABASE < sql/service_catalog.sql    # บริการครั้งเดียว
mysql -h HOST -u USER -p DATABASE < sql/services_receipts.sql  # ลิงก์ Polar ของบริการ + ไฟล์แนบใบเสร็จ
mysql -h HOST -u USER -p DATABASE < sql/platform_schema.sql    # สินค้า แพ็กเกจ subscription key โควตา
mysql -h HOST -u USER -p DATABASE < sql/admin_users.sql        # บัญชีแอดมิน
mysql -h HOST -u USER -p DATABASE < sql/ai_gateway.sql         # AI gateway: ราคาโมเดล + จำกัดโมเดลต่อแพ็กเกจ
mysql -h HOST -u USER -p DATABASE < sql/ework_billing.sql      # E-work: token ต่อโหมด, ฟรีครั้งเดียว, สินค้า/แพ็กเกจ e-work (ต้องมี usage_runs จาก usage_schema เดิม)
mysql -h HOST -u USER -p DATABASE < sql/ai_customer_keys.sql     # OpenAI key รายลูกค้า (เข้ารหัส) — ต้องตั้ง DATA_ENCRYPTION_KEY
```
อัปเกรดจากระบบเดิม (Ework): รัน `services_receipts.sql` (ถ้ายังไม่ได้รัน) และ `platform_schema.sql` แล้ว **สำรองข้อมูลก่อน** จึงรัน `sql/drop_ework.sql` เพื่อลบตารางการใช้งานของ Ework (`usage_runs`, `usage_prices`, view `v_usage_*`, `billing_usage_reports`) — SN, บัญชีลูกค้า และใบแจ้งหนี้เดิมยังอยู่ครบ

user ของเว็บต้องมีสิทธิ์ `SELECT, INSERT, UPDATE, DELETE` ทุกตารางของแอป (ดู `sql/grants_optional.sql`)

## 2. ตั้งค่า `.env`
```bash
cd webapp && npm install
copy .env.example .env      # Linux/Mac: cp .env.example .env
```
- `SESSION_SECRET` (สุ่ม 64 ตัว: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `DB_*`
- `ADMIN_PASSWORD` = **รหัสตั้งค่าใช้ครั้งเดียว** (10+ ตัว) สำหรับสร้างบัญชี owner คนแรกที่ `/login` — หลังจากนั้นแอดมินใช้บัญชีในตาราง `admin_users` (รัน `sql/admin_users.sql`) เพิ่มคนอื่น/รีเซ็ตรหัส/2FA ได้ที่ **Admin users** และ **My account**
- **ข้อมูลธุรกิจ** `COMPANY_NAME` `COMPANY_NAME_EN` `COMPANY_TAX_ID` `COMPANY_ADDRESS` `COMPANY_EMAIL` `COMPANY_PHONE` `SITE_URL`
- AI gateway: `OPENAI_API_KEY` (key ของ Project ใน platform.openai.com — อยู่บนเซิร์ฟเวอร์เท่านั้น) `AI_USD_THB` `AI_PRODUCT_SLUG` (ข้อ 5)
- Polar: `PAYMENT_PROVIDER=polar` `POLAR_ACCESS_TOKEN` `POLAR_WEBHOOK_SECRET` `POLAR_PRODUCT_ID` `POLAR_SERVER` (ข้อ 4) — แพ็กเกจรายเดือน/รายปีใช้ได้กับ Polar เท่านั้น

```bash
npm start        # http://localhost:3000  (หลังบ้าน /admin)
node seed.js     # (ทางเลือก) สินค้า/แพ็กเกจ/ลูกค้าตัวอย่าง (demo-acme / demo1234) — ลบด้วย node seed.js --clean
```

## 3. เอาขึ้นออนไลน์
- **Plesk:** [DEPLOY-PLESK.md](DEPLOY-PLESK.md)
- ต้องเป็น HTTPS บนโดเมนจริง เพราะ Polar ต้องยิง webhook มาหา
- **VPS:** `docker compose up -d` (เว็บ + MariaDB สร้างตารางให้เอง) แล้วตั้ง reverse proxy ชี้พอร์ต 3000
- cron ทุกวันที่ 1 ออกบิลค่าใช้งานเกินโควตา/จ่ายตามใช้งานของเดือนก่อน: `0 6 1 * * cd /path/webapp && node invoices.js >> invoices.log 2>&1`

## 4. สินค้า แพ็กเกจ และการเก็บเงิน
**สินค้า** (Admin → Products) มี 2 แบบ:
- **API key** — ลูกค้าสร้าง API key ได้ตามจำนวนที่แพ็กเกจกำหนด (แสดง key ครั้งเดียว เก็บแค่ hash) backend ของบริการเรียก `/api/v1/authorize` ทุก request
- **License key** — ลูกค้าได้ license key ไปใส่ในโปรแกรม โปรแกรมเรียก `/api/v1/license/verify` จำกัดจำนวนเครื่องต่อ key

**แพ็กเกจ** ของแต่ละสินค้า:
| billing | เก็บเงิน | โควตา/เดือน (รีเซ็ตวันที่ 1) |
|---|---|---|
| `month` / `year` ราคา > 0 | Polar subscription (สินค้า **recurring** ใน Polar ราคาเดียวกัน → ใส่ Polar product ID ในแพ็กเกจ) | `included_units` · เกินแล้ว: `unit_price_thb` = 0 → บล็อก, > 0 → ใช้ต่อได้และออกบิลเดือนถัดไป |
| `month` / `year` ราคา 0 | ฟรี เปิดใช้ทันที | เหมือนข้างบน |
| `usage` | ไม่มีค่ารายเดือน ออกบิลตามใช้จริงวันที่ 1 | `included_units` = ใช้ฟรีต่อเดือน (ว่าง = ไม่จำกัด) |

Polar ต้องตั้ง: **Access token** scopes `checkouts:write products:read orders:read orders:write customers:write customer_sessions:write subscriptions:write` · **Webhook** `SITE_URL/webhooks/polar` Format **Raw** events `order.paid order.updated order.refunded subscription.created subscription.active subscription.updated subscription.canceled subscription.uncanceled subscription.revoked` · ทดสอบที่ **sandbox.polar.sh** กับ `POLAR_SERVER=sandbox` (บัตร 4242 4242 4242 4242)

ลำดับเหตุการณ์: ลูกค้ากด Subscribe → checkout ของ Polar (metadata `subscription_ref`) → `subscription.active` เปิดแพ็กเกจ + ย้าย key จากแพ็กเกจเดิมของสินค้าเดียวกัน → `order.paid` ทุกรอบบันทึกเป็นใบแจ้งหนี้ paid พร้อมใบเสร็จของ Polar → ลูกค้ายกเลิก = ใช้ได้ถึงสิ้นรอบ · แอดมินเปิดแพ็กเกจให้เองได้ (ทดลองใช้/โอนเงิน) ที่ Admin → Subscriptions

## 5. Platform API
**ตรวจ API key + นับการใช้งาน** (เรียกจาก backend ของบริการเท่านั้น — service secret สร้างที่หน้าสินค้า):
```http
POST /api/v1/authorize
Authorization: Bearer dca_svc_…
Content-Type: application/json

{ "key": "dca_sk_…", "units": 1 }
```
`200 { ok, customer, plan, quota: { used, included, remaining, overage_units } }` · `401 invalid_key/revoked_key` · `402 payment_required` · `403 inactive/wrong_product/suspended` · `429 quota_exceeded/rate_limited` · `"dry_run": true` = ตรวจโดยไม่นับ

**ลูกค้าดูโควตา:** `GET /api/v1/usage` + `Authorization: Bearer dca_sk_…`

**ตรวจ license** (โปรแกรมเรียก ไม่ต้องใช้ secret):
```http
POST /api/v1/license/verify
{ "license_key": "DCL-XXXX-XXXX-XXXX-XXXX", "product": "slug", "device_id": "…", "device_name": "PC-01", "app_version": "1.0" }
```
`200 { ok, plan, expires_at, features, max_devices }` · `403 device_limit` (ลูกค้าลบเครื่องเก่าได้ในพอร์ทัล)

**AI gateway** (ลูกค้าเรียกตรง รูปแบบเดียวกับ OpenAI — ใช้ OpenAI SDK ได้ แค่เปลี่ยน `base_url`):
```python
from openai import OpenAI
client = OpenAI(base_url="https://datacorpapi.com/v1", api_key="dca_sk_…")
client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "สวัสดี"}])
```
- `POST /v1/chat/completions` (รองรับ `stream: true`) · `GET /v1/models` (เฉพาะโมเดลที่แพ็กเกจใช้ได้)
- ใช้ key ของสินค้า `AI_PRODUCT_SLUG` (ai-api) ระบบตรวจ key/แพ็กเกจ/โควตา → จำกัดโมเดล (`allowed_models`) และ `max_output_tokens` ตามแพ็กเกจ → ส่งต่อ OpenAI ด้วย `OPENAI_API_KEY` → นับ **credits** จาก usage จริง
- 1 credit = ฿0.001 ของต้นทุน OpenAI = (prompt × ราคา input + completion × ราคา output) ÷ 1M × `AI_USD_THB` × 1000 — แก้ราคา/เปิดปิดโมเดลที่ **Admin → AI models** (มีปุ่มทดสอบการเชื่อมต่อ OpenAI)
- error จาก OpenAI ที่เป็นเรื่องบัญชีเรา (401/403/429) ลูกค้าเห็นแค่ `503 service_unavailable/upstream_busy` — ดูรายละเอียดใน log `[ai]`
- ตั้ง **monthly budget** ของ Project ใน OpenAI ด้วยเสมอ

**E-work (โปรแกรมเดสก์ท็อป) — license + token:**
- โปรแกรมส่งงานที่ทำเสร็จ: `POST /api/v1/ework/usage { "serial": "DCA-…", "rows": [ { event_id, mode, status, record_count, progress_done, started_at, … } ] }` (≤200 แถว/ครั้ง กันซ้ำด้วย `event_id`) → `{ ok, accepted, duplicates, tokens }`
- token ต่องาน = รายการ × `tokens_per_record` (+ `tokens_per_run` ถ้าสำเร็จ) ตาม `ework_token_rates` · ฟรีครั้งเดียวต่อลูกค้า = `lifetime_free_units` ของแพ็กเกจ (แก้รายคนได้) · ส่วนเกินเข้า `usage_counters` ของ subscription → ออกบิลรายเดือนตาม `unit_price_thb`
- ตรวจ SN (`/api/license/verify`) ต้องมี subscription สินค้า `e-work` ที่ใช้งานได้ และคืนยอด token กลับไปด้วย
- หลังบ้าน **E-work license**: ยอดต่อลูกค้า, ให้ license, แก้ token ต่อโหมด, ฟรีรายคน — โปรแกรมรุ่นเก่าที่ยังเขียน `usage_runs` ตรงจะถูกคิดให้ทุก 5 นาที

**SN ของบัญชี (เดิม):** `POST /api/license/verify { serial, install_id, machine, windows_user, app_version }` — ไม่เปลี่ยน

## 6. โครงสร้าง
```
webapp/
  server.js            เส้นทางทั้งหมด (public / portal / admin / api / webhook)
  lib/platform.js      สินค้า แพ็กเกจ subscription key โควตา, authorize/verify, webhook subscription ของ Polar
  lib/invoices.js      ใบแจ้งหนี้: ค่าใช้งานเกินโควตา, ค่าสมาชิก (จาก Polar), บริการ, ไฟล์แนบ
  lib/polar.js         Polar: checkout (ยอดคงที่ / subscription), ยกเลิก/ต่ออายุ, customer portal, webhook, ใบเสร็จ
  lib/payments.js      เลือกผู้ให้บริการรับชำระเงิน
  lib/billing.js       บันทึก webhook
  lib/services.js      บริการครั้งเดียว
  lib/portal.js        บัญชีลูกค้า + SN
  lib/lemonsqueezy.js  Lemon Squeezy (สำรอง: บิลครั้งเดียว)
  invoices.js          CLI ออกบิลค่าใช้งานรายเดือน (cron วันที่ 1)
  portal_user.js       CLI สร้าง/รีเซ็ตบัญชีลูกค้า
  seed.js              ข้อมูลตัวอย่าง (--clean ลบออก)
  diag.js              ตรวจ env/DB/โมดูล จาก Plesk Run script
  views/site  views/portal  views (admin)   public/style.css site.css
```
