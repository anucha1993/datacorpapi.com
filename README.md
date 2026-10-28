# เว็บไซต์ + ระบบหลังบ้าน — DataCorp API (บริการออกแบบระบบด้วย AI, ระบบอัตโนมัติ, รับทำเว็บไซต์)

Node.js (Express + EJS) + MySQL/MariaDB ทำ 3 หน้าที่ในแอปเดียว

| ส่วน | URL | ใครเข้า |
|---|---|---|
| **หน้าเว็บสาธารณะ** สินค้า · ราคา · ข้อกำหนด · คืนเงิน · ความเป็นส่วนตัว · ติดต่อ | `/` `/pricing` `/terms` `/refund` `/privacy` `/contact` | ทุกคน (ผู้ตรวจของผู้ให้บริการรับชำระเงินด้วย) |
| **Customer Portal** ลูกค้าดูยอดใช้งานของตัวเอง · ใบแจ้งหนี้ · ชำระเงินผ่าน Polar · ข้อมูลออกใบเสร็จ | `/portal` (บัญชีลูกค้า) | ลูกค้า |
| **หลังบ้าน** ยอดการใช้งาน · ใบแจ้งหนี้รายเดือน · บัญชีลูกค้า · ตั้งราคา · ข้อความติดต่อ | `/admin` (รหัสผ่าน) | คุณ |
| **Webhook** รับผลการชำระเงินจาก Polar → มาร์คบิลชำระแล้ว + ลิงก์ใบเสร็จ | `/webhooks/polar` (Lemon Squeezy เดิม: `/webhooks/lemonsqueezy`) | Polar |

## 1. ฐานข้อมูล (ครั้งเดียว)
สร้าง database + user ผ่านหน้าควบคุมของโฮสต์ แล้วรัน 4 ไฟล์นี้ตามลำดับใน database นั้น (phpMyAdmin → SQL หรือ):
```bash
mysql -h HOST -u USER -p DATABASE < sql/usage_schema.sql     # การใช้งาน + ราคา + view
mysql -h HOST -u USER -p DATABASE < sql/billing_schema.sql   # ข้อมูลจาก Lemon Squeezy (ลูกค้า/คำสั่งซื้อ/webhook) + ข้อความติดต่อ
mysql -h HOST -u USER -p DATABASE < sql/portal_schema.sql    # บัญชี login ของลูกค้า
mysql -h HOST -u USER -p DATABASE < sql/invoice_schema.sql   # ใบแจ้งหนี้ + ข้อมูลออกใบเสร็จ
mysql -h HOST -u USER -p DATABASE < sql/invoice_manual.sql   # บิลระบุยอดเอง
mysql -h HOST -u USER -p DATABASE < sql/polar_schema.sql     # Polar order/receipt
mysql -h HOST -u USER -p DATABASE < sql/service_catalog.sql  # แคตตาล็อกบริการที่ขายในพอร์ทัล
mysql -h HOST -u USER -p DATABASE < sql/services_receipts.sql # ลิงก์ชำระเงิน Polar ของบริการ + ไฟล์แนบใบเสร็จ
```

## 2. ตั้งค่า `.env`
```bash
cd webapp && npm install
copy .env.example .env      # Linux/Mac: cp .env.example .env
```
แก้ใน `.env`
- `ADMIN_PASSWORD`, `SESSION_SECRET`
- `DB_*` ของ database ข้อ 1
- **ข้อมูลธุรกิจ** `COMPANY_NAME` `COMPANY_NAME_EN` `COMPANY_TAX_ID` `COMPANY_ADDRESS` `COMPANY_EMAIL` `COMPANY_PHONE` `SITE_URL` — แสดงบนทุกหน้า ผู้ตรวจของผู้ให้บริการรับชำระเงินต้องเห็น ถ้ายังเป็น `CHANGE_ME` จะเตือนตอนเริ่มและที่หน้า admin
- Polar: `PAYMENT_PROVIDER=polar` `POLAR_ACCESS_TOKEN` `POLAR_WEBHOOK_SECRET` `POLAR_PRODUCT_ID` `POLAR_SERVER` (ข้อ 4) — Lemon Squeezy ยังเลือกได้ด้วย `PAYMENT_PROVIDER=lemonsqueezy` + `LS_*`

```bash
npm start        # http://localhost:3000  (หลังบ้าน /admin)
node seed.js     # (ทางเลือก) ใส่ข้อมูลตัวอย่างไว้ดูหน้าจอ — ลบออกด้วย node seed.js --clean
```

## 3. เอาขึ้นออนไลน์
- **Plesk:** ดูขั้นตอนละเอียดใน [DEPLOY-PLESK.md](DEPLOY-PLESK.md)
- ต้องเป็น HTTPS บนโดเมนจริง (เช่น `https://datacorpapi.com`) เพราะ Lemon Squeezy ต้องยิง webhook มาหาและผู้ตรวจต้องเปิดดูได้
- **VPS:** `docker compose up -d` (เว็บ + MariaDB/MySQL) แล้วตั้ง reverse proxy (Caddy/Nginx/Cloudflare Tunnel) ชี้พอร์ต 3000 หรือรันด้วย `pm2 start server.js --name ewp-web`
- **โฮสต์ Node.js (cPanel "Setup Node.js App", Render, Railway):** ชี้ที่ `server.js` ตั้ง env ตาม `.env` และใช้ MySQL ของโฮสต์ (โปรแกรมบนเครื่องผู้ใช้ต้องต่อ MySQL ตัวเดียวกันได้ — เปิด Remote MySQL ให้ IP ของออฟฟิศ)
- ตั้ง cron ออกใบแจ้งหนี้ทุกวันที่ 1: `0 6 1 * * cd /path/webapp && node invoices.js >> invoices.log 2>&1`

## 4. ตั้งค่า Polar (polar.sh) — โมเดล: จ่ายตามบิลรายเดือน
ลูกค้า**ไม่ได้สมัคร subscription** — ทุกวันที่ 1 ระบบออกใบแจ้งหนี้ของเดือนก่อนให้แต่ละลูกค้า แล้วสร้าง checkout ของ Polar ผ่าน API ที่ใส่ยอดจริงของบิลนั้นเป็นราคาคงที่ (ad-hoc fixed price, THB) ลูกค้ากดจ่ายในพอร์ทัล → webhook `order.paid` มาร์คชำระแล้ว → ระบบขอใบเสร็จ (order invoice) จาก Polar มาแสดงในพอร์ทัล

**ไม่ต้องสร้าง Checkout Link ในหน้า Polar** (ลิงก์คงที่ใช้ไม่ได้กับยอดที่ต่างกันทุกบิล) สิ่งที่ต้องทำใน Polar มี 4 อย่าง:
1. **Organization** ชื่อ/อีเมล/ที่อยู่ตรงกับที่แสดงบนเว็บ · Settings → General: เปิดรับ THB (ถ้ามีตัวเลือกสกุลเงิน)
2. **Product 1 ตัว แบบ One-time** ชื่อเช่น `DataCorp API services` ราคาตั้ง Pay what you want (ขั้นต่ำ ฿17, หรือ Fixed ก็ได้ — ระบบส่งยอดจริงทับทุกครั้ง) → คัดลอก Product ID ใส่ `POLAR_PRODUCT_ID` (เว้นว่างได้ ระบบหยิบสินค้า one-time ตัวแรก)
3. **Access token** Settings → API → New token (Organization) scopes: `checkouts:write` `products:read` `orders:read` `orders:write` `customers:write` → `POLAR_ACCESS_TOKEN`
4. **Webhook** Settings → Webhooks → Add endpoint: URL `SITE_URL/webhooks/polar` · Format **Raw** · events `order.paid` `order.updated` `order.refunded` → คัดลอก secret ใส่ `POLAR_WEBHOOK_SECRET`
5. **ทดสอบ** ทำข้อ 2–4 ซ้ำที่ **sandbox.polar.sh** (token/webhook คนละชุด) แล้วตั้ง `POLAR_SERVER=sandbox` → ลิงก์ชำระเงินเป็น sandbox (บัตร 4242 4242 4242 4242) เมื่อพร้อมเก็บเงินจริงใส่ token/secret ของ production และตั้ง `POLAR_SERVER=production`

### รอบการเรียกเก็บ
โปรแกรมบนเครื่องลูกค้าส่งยอดเข้า `usage_runs` → วันที่ 1: `node invoices.js` (cron) หรือปุ่ม "ออกใบแจ้งหนี้" ใน `/admin/invoices` → บิล `open` + ลิงก์ชำระ (ยอด < ฿17 → `carried` ยกไปเดือนถัดไป) → ลูกค้าเห็นบิลใน `/portal/billing` กด "ชำระเงิน" (หน้าชำระเงินเติมชื่อบริษัท/เลขภาษี/ที่อยู่จาก `/portal/profile`) → webhook `order.paid` → บิล `paid` + ลิงก์ใบเสร็จ (Polar order invoice) · แอดมินแก้ยอด/ให้ส่วนลด/รับชำระเอง/ยกเลิกได้ · ครบกำหนด `INVOICE_DUE_DAYS` วัน

## 5. สิ่งที่หน้าเว็บมีตามข้อกำหนดของผู้ให้บริการรับชำระเงิน
ชื่อธุรกิจ · คำอธิบายสินค้าที่ตรงกับที่แจ้ง (ซอฟต์แวร์ ไม่ใช่บริการ) · ราคาและวิธีคิดเงินทุกแพ็กเกจ · นโยบายคืนเงิน/ยกเลิก · ข้อกำหนดการใช้บริการ · นโยบายความเป็นส่วนตัว (PDPA) · ช่องทางติดต่อ (อีเมล โทร ที่อยู่ ฟอร์ม) · ระบุว่าผู้ให้บริการรับชำระเงิน (Polar) เป็น Merchant of Record · ทุกหน้าเปิดได้โดยไม่ต้อง login และมีสรุปภาษาอังกฤษ

> ก่อนยื่นขอเปิดร้าน: กรอก `.env` ให้ครบ, ใส่ภาพหน้าจอโปรแกรมที่ `public/screenshot-app.png` (ไม่บังคับ), อ่านข้อความในหน้า `/terms` `/refund` `/privacy` แล้วแก้ให้ตรงกับที่คุณจะทำจริง (เช่น จำนวนวันคืนเงิน)

## 6. โครงสร้าง
```
webapp/
  server.js            เส้นทางทั้งหมด (public / admin / webhook / api)
  lib/payments.js      เลือกผู้ให้บริการรับชำระเงิน (polar / lemonsqueezy) จาก env
  lib/polar.js         Polar: สร้าง checkout ยอดคงที่ (THB), ตรวจลายเซ็น webhook (Standard Webhooks), ขอใบเสร็จของ order
  lib/lemonsqueezy.js  Lemon Squeezy (ตัวเลือกสำรอง): ตรวจลายเซ็น webhook, สร้าง checkout ด้วยยอดบิล (custom_price)
  lib/billing.js       บันทึก webhook → billing_*
  lib/invoices.js      คำนวณ/ออกใบแจ้งหนี้, ปรับยอด, มาร์คชำระจาก webhook
  lib/portal.js        บัญชีลูกค้า (scrypt)
  lib/company.js       ข้อมูลธุรกิจจาก .env
  plans.json           แพ็กเกจที่แสดง/ขาย
  invoices.js          CLI ออกใบแจ้งหนี้รายเดือน (cron วันที่ 1)
  portal_user.js       CLI สร้าง/รีเซ็ตบัญชีลูกค้า
  seed.js              ข้อมูลตัวอย่าง (--clean ลบออก)
  diag.js              ตรวจ env/DB/โมดูล จาก Plesk Run script
  views/site/*.ejs     หน้าเว็บสาธารณะ   views/portal/*.ejs  พอร์ทัลลูกค้า   views/*.ejs  หน้า admin
  public/style.css, site.css
  Dockerfile, docker-compose.yml
```
สูตรยอดเงิน (view `v_usage_monthly`): `รายการที่คิดเงิน × ราคา/รายการ + จำนวนครั้ง × ราคา/ครั้ง` โดยงานที่ยกเลิก/ผิดพลาดคิดจากจำนวนที่ทำไปแล้วจริง
