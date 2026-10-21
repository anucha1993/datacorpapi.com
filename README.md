# เว็บไซต์ + ระบบหลังบ้าน — e-WorkPermit Tools

Node.js (Express + EJS) + MySQL/MariaDB ทำ 3 หน้าที่ในแอปเดียว

| ส่วน | URL | ใครเข้า |
|---|---|---|
| **หน้าเว็บสาธารณะ** สินค้า · ราคา · สมัคร/ชำระเงิน · ข้อกำหนด · คืนเงิน · ความเป็นส่วนตัว · ติดต่อ | `/` `/pricing` `/terms` `/refund` `/privacy` `/contact` | ทุกคน (ผู้ตรวจของ Lemon Squeezy ด้วย) |
| **หลังบ้าน** ยอดการใช้งาน · ลูกค้า/subscription · ส่งยอดไป Lemon Squeezy · ตั้งราคา · ข้อความติดต่อ | `/admin` (รหัสผ่าน) | คุณ |
| **Webhook** รับคำสั่งซื้อ/subscription จาก Lemon Squeezy | `/webhooks/lemonsqueezy` | Lemon Squeezy |

## 1. ฐานข้อมูล (ครั้งเดียว)
สร้าง database + user ผ่านหน้าควบคุมของโฮสต์ (cPanel/DirectAdmin) หรือใช้ `sql/grants_optional.sql` ถ้าโฮสต์เอง แล้วรัน 2 ไฟล์นี้ใน database นั้น (phpMyAdmin → SQL หรือ):
```bash
mysql -h HOST -u USER -p DATABASE < sql/usage_schema.sql
mysql -h HOST -u USER -p DATABASE < sql/billing_schema.sql
```
ได้ตาราง `usage_runs` `usage_prices` `billing_*` `contact_messages` และ view `v_usage_monthly*` `v_usage_installs`

## 2. ตั้งค่า `.env`
```bash
cd webapp && npm install
copy .env.example .env      # Linux/Mac: cp .env.example .env
```
แก้ใน `.env`
- `ADMIN_PASSWORD`, `SESSION_SECRET`
- `DB_*` ของ database ข้อ 1
- **ข้อมูลธุรกิจ** `COMPANY_NAME` `COMPANY_NAME_EN` `COMPANY_TAX_ID` `COMPANY_ADDRESS` `COMPANY_EMAIL` `COMPANY_PHONE` `SITE_URL` — แสดงบนทุกหน้า ผู้ตรวจของผู้ให้บริการรับชำระเงินต้องเห็น ถ้ายังเป็น `CHANGE_ME` จะเตือนตอนเริ่มและที่หน้า admin
- Lemon Squeezy: `LS_API_KEY` `LS_WEBHOOK_SECRET` และลิงก์ checkout (ข้อ 4)

```bash
npm start        # http://localhost:3000  (หลังบ้าน /admin)
node seed.js     # (ทางเลือก) ใส่ข้อมูลตัวอย่างไว้ดูหน้าจอ — ลบออกด้วย node seed.js --clean
```

## 3. เอาขึ้นออนไลน์
- **Plesk:** ดูขั้นตอนละเอียดใน [DEPLOY-PLESK.md](DEPLOY-PLESK.md)
- ต้องเป็น HTTPS บนโดเมนจริง (เช่น `https://ewp.thefirstgoodmangroup.com`) เพราะ Lemon Squeezy ต้องยิง webhook มาหาและผู้ตรวจต้องเปิดดูได้
- **VPS:** `docker compose up -d` (เว็บ + MariaDB/MySQL) แล้วตั้ง reverse proxy (Caddy/Nginx/Cloudflare Tunnel) ชี้พอร์ต 3000 หรือรันด้วย `pm2 start server.js --name ewp-web`
- **โฮสต์ Node.js (cPanel "Setup Node.js App", Render, Railway):** ชี้ที่ `server.js` ตั้ง env ตาม `.env` และใช้ MySQL ของโฮสต์ (โปรแกรมบนเครื่องผู้ใช้ต้องต่อ MySQL ตัวเดียวกันได้ — เปิด Remote MySQL ให้ IP ของออฟฟิศ)
- ตั้ง cron ส่งยอดทุกวัน (ส่งซ้ำได้ ค่าใหม่ทับค่าเดิม): `50 23 * * * cd /path/webapp && node report_usage.js >> usage_report.log 2>&1`

## 4. ตั้งค่า Lemon Squeezy
1. **สมัครและเปิดร้าน** ตอบแบบสอบถามว่าเป็น **ซอฟต์แวร์/SaaS แบบ subscription** (Lemon Squeezy ไม่รับร้านที่ขาย "บริการ" หรือสินค้าที่ส่งมอบนอกระบบ) ระบุ URL เว็บนี้
2. **สร้าง Product** 1 ตัว (variant เดียว) ตาม `plans.json`
   - `Pay as you go` — Subscription รายเดือน ราคา 0 แล้วเปิด **Usage-based billing** เลือก aggregation **"Most recent usage during period"** (ตรงกับ `LS_USAGE_ACTION=set` ส่งซ้ำได้) ตั้ง **ราคาต่อหน่วย = ฿1** แล้วใช้ `LS_USAGE_QUANTITY=amount` (ค่าเริ่มต้น): ระบบจะส่ง "ยอดเงินบาท" ของเดือนนั้นเป็นจำนวนหน่วย จึงคิดราคาต่างกันแต่ละโหมดตามหน้า `/admin/prices` ได้ตรง ๆ (ถ้าอยากให้ LS แสดงเป็นจำนวนรายการ ใช้ `records` และตั้งราคาเดียวทุกโหมด)
3. **Checkout link** ของแต่ละ variant (Share → Checkout link) ใส่ใน `plans.json` ช่อง `checkout_url` หรือ env `LS_CHECKOUT_URL_PAYG`
   - ในหน้า product ตั้ง **Redirect after purchase** = `SITE_URL/thanks`
4. **Webhook** Settings → Webhooks → URL `SITE_URL/webhooks/lemonsqueezy`, ใส่ signing secret เดียวกับ `LS_WEBHOOK_SECRET`, ติ๊ก `order_created` `order_refunded` `subscription_*` ทั้งหมด
5. **API key** Settings → API → ใส่ `LS_API_KEY`
6. ทดสอบด้วย **Test mode** ก่อน (สลับ toggle ใน dashboard; checkout link ของ test mode คนละตัว)

### ไหลของเงิน
ลูกค้ากรอกอีเมล + **ชื่อผู้ใช้งาน** ที่หน้า `/pricing` → ไป checkout ของ Lemon Squeezy (เราส่ง `checkout[custom][operator]` ไปด้วย) → webhook `subscription_created` บันทึกลูกค้า + ผูก operator → ลูกค้าใส่ชื่อเดียวกันในโปรแกรม → ยอดเข้าตาราง `usage_runs` → ปลายเดือน (cron หรือปุ่มในหน้า `/admin/billing`) ส่ง `billable_records` ของ operator นั้นไปเป็น usage record ของ subscription → Lemon Squeezy ออกใบแจ้งหนี้/ตัดบัตรและส่งใบเสร็จให้ลูกค้าเอง

## 5. สิ่งที่หน้าเว็บมีตามข้อกำหนดของผู้ให้บริการรับชำระเงิน
ชื่อธุรกิจ · คำอธิบายสินค้าที่ตรงกับที่แจ้ง (ซอฟต์แวร์ ไม่ใช่บริการ) · ราคาและวิธีคิดเงินทุกแพ็กเกจ · นโยบายคืนเงิน/ยกเลิก · ข้อกำหนดการใช้บริการ · นโยบายความเป็นส่วนตัว (PDPA) · ช่องทางติดต่อ (อีเมล โทร ที่อยู่ ฟอร์ม) · ระบุว่า Lemon Squeezy เป็น Merchant of Record · ทุกหน้าเปิดได้โดยไม่ต้อง login และมีสรุปภาษาอังกฤษ

> ก่อนยื่นขอเปิดร้าน: กรอก `.env` ให้ครบ, ใส่ภาพหน้าจอโปรแกรมที่ `public/screenshot-app.png` (ไม่บังคับ), อ่านข้อความในหน้า `/terms` `/refund` `/privacy` แล้วแก้ให้ตรงกับที่คุณจะทำจริง (เช่น จำนวนวันคืนเงิน)

## 6. โครงสร้าง
```
webapp/
  server.js            เส้นทางทั้งหมด (public / admin / webhook / api)
  lib/lemonsqueezy.js  ตรวจลายเซ็น webhook, API usage-records, สร้างลิงก์ checkout
  lib/billing.js       บันทึก webhook → billing_*, ส่งยอดรายเดือน
  lib/company.js       ข้อมูลธุรกิจจาก .env
  plans.json           แพ็กเกจที่แสดง/ขาย
  report_usage.js      CLI ส่งยอด (สำหรับ cron)
  views/site/*.ejs     หน้าเว็บสาธารณะ   views/*.ejs  หน้า admin
  public/style.css, site.css
  Dockerfile, docker-compose.yml
```
สูตรยอดเงิน (view `v_usage_monthly`): `รายการที่คิดเงิน × ราคา/รายการ + จำนวนครั้ง × ราคา/ครั้ง` โดยงานที่ยกเลิก/ผิดพลาดคิดจากจำนวนที่ทำไปแล้วจริง
