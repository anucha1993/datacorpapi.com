# Deploy บน Plesk (Node.js + MariaDB ในเซิร์ฟเวอร์เดียว)

ใช้กับ Plesk Obsidian ที่ติดตั้ง **Node.js extension** (Passenger) แล้ว — ถ้ายังไม่มี ให้ติดตั้งจาก Plesk → Extensions → "Node.js"

## 0. สิ่งที่ต้องมีก่อน
- โดเมน `datacorpapi.com` ชี้ A record มาที่ IP ของเซิร์ฟเวอร์ Plesk แล้ว
- database `thaidata_ewp` + user สร้างแล้วและรัน `sql/usage_schema.sql`, `sql/billing_schema.sql`, `sql/portal_schema.sql`, `sql/invoice_schema.sql` แล้ว (ทำไปแล้ว)
- โค้ดอยู่บน GitHub `anucha1993/datacorpapi.com` (ต้อง `git push` ก่อน) หรือจะอัปโหลดโฟลเดอร์ `webapp/` ผ่าน File Manager ก็ได้

## 1. เอาโค้ดขึ้นเซิร์ฟเวอร์
**วิธี A — Git (แนะนำ อัปเดตครั้งต่อไปกดปุ่มเดียว)**
1. Plesk → Websites & Domains → datacorpapi.com → **Git** → Add repository
2. Remote repository URL: `https://github.com/anucha1993/datacorpapi.com.git` (repo private ต้องใส่ deploy key ที่ Plesk สร้างให้ลงใน GitHub → Settings → Deploy keys)
3. Deployment mode: Automatic · Deploy to: `/httpdocs` (หรือโฟลเดอร์อื่นก็ได้)

**วิธี B — อัปโหลดเอง** File Manager → อัปโหลดโฟลเดอร์ `webapp/` ไปที่ `/httpdocs/webapp` (ไม่ต้องเอา `node_modules/` และ `.env` ขึ้น)

## 2. สร้าง Node.js application
Websites & Domains → datacorpapi.com → **Node.js** → Enable Node.js แล้วตั้งค่า

| ช่อง | ค่า |
|---|---|
| Node.js version | 20 หรือ 22 (ต้อง ≥ 18) |
| Package manager | npm |
| Document root | `/httpdocs/webapp/public` |
| Application mode | `production` |
| Application root | `/httpdocs/webapp` |
| Application startup file | `server.js` |

กด **NPM install** (ติดตั้ง dependencies จาก package-lock.json)

> Document root ชี้ที่ `public/` เพื่อให้ Apache/nginx เสิร์ฟ CSS/รูปตรง ๆ ส่วน URL อื่นทั้งหมด Passenger ส่งต่อให้ `server.js` — แอป `listen()` พอร์ตอะไรก็ได้ Passenger จัดการเอง

## 3. ตั้งค่า `.env`
ที่ File Manager สร้างไฟล์ `/httpdocs/webapp/.env` (คัดลอกจาก `.env.example`) ค่าที่ต่างจากเครื่องตัวเอง:
```env
PORT=3000
ADMIN_PASSWORD=<รหัสยาว ๆ ใหม่>
SESSION_SECRET=<สุ่ม 40+ ตัวอักษร>
DB_HOST=localhost            # MariaDB อยู่เครื่องเดียวกัน
DB_PORT=3306
DB_NAME=thaidata_ewp
DB_USER=thaidata_ewp_web
DB_PASSWORD=<รหัสของ user นี้>
SITE_URL=https://datacorpapi.com
COMPANY_NAME=datacorpapi.com
COMPANY_ADDRESS=45/107 ซอย 26 โครงการเวอร์โซ่ วงแหวน-ลำลูกกา ตำบลบึงคำพร้อย อำเภอลำลูกกา จังหวัดปทุมธานี 12150
COMPANY_EMAIL=info@datacorpapi.com
PAYMENT_PROVIDER=polar
POLAR_ACCESS_TOKEN=polar_oat_...
POLAR_WEBHOOK_SECRET=whsec_...
POLAR_PRODUCT_ID=
POLAR_SERVER=sandbox
```
หรือใส่เป็น **Custom environment variables** ในหน้า Node.js ของ Plesk แทนไฟล์ก็ได้ (แอปอ่านทั้งสองทาง) จากนั้นกด **Restart App**

## 4. HTTPS
Websites & Domains → **SSL/TLS Certificates** → Install Let's Encrypt (ติ๊ก www และ wildcard ไม่จำเป็น) → เปิด **Permanent SEO-safe 301 redirect from HTTP to HTTPS** ใน Hosting Settings

## 5. ตรวจว่าใช้งานได้
- `https://datacorpapi.com/api/health` ต้องได้ `{"ok":true}` (ถ้า `ok:false` = ต่อ DB ไม่ได้ ดู DB_* ใน .env)
- `https://datacorpapi.com/` หน้าแรก และ `/admin` login ได้
- ถ้าขึ้นหน้า error ของ Passenger ให้ดู log: Node.js → **Show logs** หรือ Websites & Domains → Logs

## 6. Polar ชี้มาที่เซิร์ฟเวอร์
- Settings → Webhooks → Add endpoint: URL `https://datacorpapi.com/webhooks/polar` · Format Raw · events `order.paid`, `order.updated`, `order.refunded` → secret ใส่ `POLAR_WEBHOOK_SECRET`
- Settings → API → Organization Access Token (scopes checkouts:write, products:read, orders:read, orders:write, customers:write) ใส่ `POLAR_ACCESS_TOKEN` · ระหว่างทดสอบใช้ token/webhook ของ sandbox.polar.sh และตั้ง `POLAR_SERVER=sandbox` → Restart App
- ทดสอบ: ออกบิลที่ `/admin/invoices` → ลูกค้า login `/portal/billing` กด "Pay now" ด้วยบัตร 4242 4242 4242 4242 → ดูที่ `/admin/invoices` ว่าเป็น "Paid" และ `/admin/billing` ส่วน "Recent webhooks"

## 7. ออกใบแจ้งหนี้อัตโนมัติทุกวันที่ 1 (Scheduled Task)
Tools & Settings → **Scheduled Tasks** → Add task → Run a command
```
/opt/plesk/node/22/bin/node /var/www/vhosts/thaidatacorp.com/datacorpapi.com/invoices.js
```
ตั้งเวลา วันที่ 1 ของทุกเดือน 06:00 (ออกบิลของเดือนก่อน) — รันซ้ำได้ ไม่ออกบิลซ้ำ

## 8. ให้โปรแกรมบนเครื่องผู้ใช้ส่งข้อมูลเข้า MariaDB ตัวนี้
- Plesk → Databases → user ที่โปรแกรมใช้ → **Access control: Allow remote connections from any host** (หรือระบุ IP ออฟฟิศ) — user `thaidata_ewp_web` เปิดอยู่แล้ว (ทดสอบจากภายนอกผ่าน)
- แนะนำสร้าง user แยกสำหรับโปรแกรม (Databases → Add database user → ติ๊กเฉพาะ **Insert** ที่ตาราง usage_runs ไม่ได้ใน UI ให้รันใน phpMyAdmin): `GRANT INSERT ON thaidata_ewp.usage_runs TO 'thaidata_ewp_app'@'%';`
- ใน `.env` ของโปรแกรมแต่ละเครื่อง: `USAGE_DB_HOST=147.50.255.13` (หรือ `db.datacorpapi.com` ถ้าตั้ง DNS) และ user/รหัสของ user นั้น

## อัปเดตเวอร์ชันถัดไป
Git → **Pull now** (หรืออัตโนมัติเมื่อ push) → Node.js → **NPM install** (ถ้า package.json เปลี่ยน) → **Restart App**

## ปัญหาที่พบบ่อย
| อาการ | สาเหตุ/วิธีแก้ |
|---|---|
| หน้า "We're sorry, but something went wrong" ของ Passenger | ดู log; มักเป็น `.env` ไม่มี `ADMIN_PASSWORD` หรือ npm install ยังไม่รัน |
| CSS ไม่โหลด | Document root ไม่ได้ชี้ `webapp/public` |
| `/api/health` → `ER_ACCESS_DENIED_ERROR` | DB_USER/DB_PASSWORD ผิด หรือ user ไม่มีสิทธิ์บน `thaidata_ewp` |
| webhook ได้ 401 | `POLAR_WEBHOOK_SECRET` ไม่ตรงกับ secret ของ endpoint ใน Polar (sandbox กับ production คนละค่า) |
| login admin แล้วเด้งกลับ | เปิดเว็บผ่าน http ปนกับ https — ใช้ https เสมอ |
