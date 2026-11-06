# HOTZA Control Center v0.6

แดชบอร์ดส่วนตัวสำหรับตรวจสถานะโดเมน (HEAD/HTTPS), เส้นทาง Redirect และบันทึกหลักฐานการสวมรอยเว็บไซต์

## คู่มือติดตั้งภาษาไทย — ทำตามลำดับ

1. **Supabase SQL Editor:** ถ้ามีฐานข้อมูล v0.1 อยู่แล้ว ให้รัน `supabase/migration-v0.2.sql` แล้ว `supabase/migration-v0.3.sql` แล้ว `supabase/migration-v0.4.sql` แล้ว `supabase/migration-v0.5.sql` แล้ว `supabase/migration-v0.6.sql` ตามลำดับ (รันซ้ำได้ทุกไฟล์) ห้ามรัน `schema.sql` ทับเพื่อเริ่มใหม่ ข้อมูลเดิมและ RLS จะอยู่ครบ จากนั้นไปที่ Supabase → Authentication → Providers → Email เพื่อ **ปิดการเปิดสมัครบัญชีสาธารณะ** UI รุ่นนี้ไม่มีปุ่มสมัครแล้ว
2. **GitHub:** แตก ZIP แล้วอัปโหลดไฟล์ทั้งหมดทับโครงเดิม โดยให้ `package.json`, `vercel.json` อยู่ root ของ Repo อย่าอัปโหลดไฟล์ `.env`/Secret. โปรเจกต์ Vercel ใช้ Next.js Preset และไม่กำหนด Output Directory เอง
3. **Vercel → Settings → Environment Variables:** เพิ่มค่าตามตารางด้านล่างใน Production จากนั้น Deploy ใหม่ และดูที่ Settings → Cron Jobs / Logs ว่า `/api/cron/run` เรียกได้ Cron ตรวจไม่เกิน 10 โดเมนต่อรอบ และตั้งเวลา 15 นาที
4. **Telegram:** สร้าง Bot ผ่าน BotFather ส่งข้อความถึง Bot หนึ่งครั้ง แล้วดู chat ID ผ่าน Telegram API (อย่าเผยแพร่ Token). ตั้งทั้งสองตัวแปรแล้ว Redeploy
5. **ทดสอบ:** เปิดหน้า Domain เพิ่มโดเมนที่ควบคุมได้ กดตรวจเอง / เปิดหรือปิดเฝ้าระวัง ตรวจตาราง `domain_checks` และ Vercel Logs; ลองเรียก `/api/cron/run` โดยไม่ส่ง Authorization ต้องได้ HTTP 401

## Vercel Environment Variables

| ชื่อ                            | วิธีนำมาใส่                                          | ความลับ                         |
| ------------------------------- | ---------------------------------------------------- | ------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase → Project Settings / API → Project URL      | Public configuration            |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → API → anon/publishable key                | Public; RLS must remain enabled |
| `SUPABASE_SERVICE_ROLE_KEY`     | Supabase → Project Settings → API → service_role key | **SECRET: server-only**         |
| `CRON_SECRET`                   | สุ่มสตริงยาวอย่างน้อย 32 ตัวอักษร                    | **SECRET: server-only**         |
| `TELEGRAM_BOT_TOKEN`            | Telegram BotFather                                   | **SECRET: server-only**         |
| `TELEGRAM_CHAT_ID`              | Chat ID ของห้องที่ต้องการแจ้งเตือน                   | Private config                  |

เฉพาะสองค่าแรกมี `NEXT_PUBLIC_`. **อย่าใส่ `SUPABASE_SERVICE_ROLE_KEY` ใน browser**, ใน GitHub หรือในหน้าบันทึกเหตุการณ์

## ทำไม HTTP 405 และปลายทาง .cc ถึงไม่ตรงกับเบราว์เซอร์?

HTTP `405 Method Not Allowed` หมายถึงเซิร์ฟเวอร์ปลายทางไม่ยอมรับวิธีตรวจ `HEAD` ที่โปรแกรมใช้อยู่ โดย **ไม่ได้พิสูจน์ว่าเบราว์เซอร์ซึ่งใช้ GET เข้าไม่ได้** ผลปลายทาง `.cc` ในประวัติเดิมหมายถึงปลายทางที่โปรแกรมได้สังเกตจาก HEAD ก่อนถูกหยุดที่ 405 ไม่ใช่ข้อยืนยันว่า redirect สำหรับ GET ไป `.cc`. ระบบ v0.2 แสดง `HEAD ไม่รองรับ / ยังสรุปไม่ได้` และ **ไม่แจ้งว่าโดเมนล่มเพียงเพราะ 405/501**. ตรวจ Redirect จริงด้วยการตรวจ Network ของเบราว์เซอร์ หรือค่ากฎ Redirect ของ Cloudflare ตามโดเมนที่ตนควบคุม

ตัวตรวจรุ่นนี้ใช้ HEAD เท่านั้น ไม่ดาวน์โหลด body ไม่สแกนเว็บไซต์อื่นโดยไม่ได้รับอนุญาต และไม่เปลี่ยน redirect/โดเมนอัตโนมัติ

## สิ่งที่ปรับปรุง v0.6

- **จับเว็บชื่อคล้าย (Certificate Transparency):** ค้นใบรับรอง SSL ทุกใบที่มีชื่อแบรนด์ (เช่น `hotza888`) แต่ไม่ใช่โดเมนของเรา ผ่าน crt.sh วันละครั้ง (09:00 น.) หรือกด "สแกนตอนนี้" ในหน้าเว็บสวมรอย (ทุก 10 นาที)
- ชื่อใหม่จะถูกสร้างเป็น incident อัตโนมัติ (ลิงก์ไปที่บันทึกใบรับรอง ไม่ใช่เว็บต้องสงสัย) และแจ้ง Telegram สรุปครั้งเดียว
- ระบบไม่เปิดเว็บต้องสงสัยเอง และไม่ตัดสินว่าเป็นเว็บปลอม ต้องตรวจเองก่อนแจ้ง
- crt.sh ฟรีแต่ช้า (20-70 วินาที) และล่มบ่อย ถ้าผลไม่น่าเชื่อถือ (ไม่เห็นแม้แต่โดเมนของเราเอง) จะนับว่าสแกนไม่สำเร็จ ไม่ใช่ "ไม่พบ"
- ค้นแบบชื่อมีคำแบรนด์ตรง ๆ เท่านั้น ยังไม่จับชื่อสะกดเลี่ยง เช่น `h0tza888`

## สิ่งที่ปรับปรุง v0.5

- **SEO เชิงเทคนิค (เตือนสีเหลือง ไม่นับเป็นเว็บล่ม):** redirect ชั่วคราว (302/303/307) ควรเป็น 301, redirect หลายทอด ควรชี้ตรงไปปลายทาง, และ header `X-Robots-Tag: noindex`
- แจ้ง Telegram เมื่อคำเตือนปรากฏ เปลี่ยน หรือหายไป

## สิ่งที่ปรับปรุง v0.4

- **SSL:** อ่านใบรับรองที่พอร์ต 443 (handshake อย่างเดียว ไม่ส่ง HTTP) เตือนเมื่อเหลือ ≤ 14 วัน, หมดอายุ หรือใบรับรองไม่ถูกต้อง
- **โดเมนหมดอายุ:** ใช้ RDAP ของ registry ตามรายชื่อ IANA ตรวจไม่เกินวันละ 2 ครั้งต่อโดเมน เตือนเมื่อเหลือ ≤ 30 วัน หรือไม่พบในทะเบียน (ไม่รองรับโดเมนชั้นสองแบบ `.co.th`)
- **DNS:** เก็บ Nameserver ไว้ ถ้าเปลี่ยนจะแจ้ง 🚨 ทันที (สัญญาณโดเมนโดนยึด) กด "รับทราบ" ในแดชบอร์ดเพื่อเคลียร์
- **405:** ถ้าเว็บปฏิเสธ HEAD จะลองซ้ำด้วย GET หนึ่งครั้ง และตัดสายทันทีหลังได้ header ไม่อ่านเนื้อหาเว็บ ปิดได้ที่ `GET_FALLBACK_ON_405` ใน `lib/audit.ts`
- แจ้ง Telegram เฉพาะตอนระดับเปลี่ยน (ok / warn / bad) ปัญหาเน็ตชั่วคราวไม่นับเป็นใบรับรองเสีย

## แก้ HTTP 403 จาก Cloudflare (โดเมนของเราเอง)

ถ้าโดเมนอยู่หลัง Cloudflare แล้วตัวตรวจได้ 403 แปลว่า Bot protection บล็อกอยู่ ให้อนุญาตตัวตรวจแทนการปลอมตัวเป็นเบราว์เซอร์:

1. Cloudflare → เลือกโดเมน → Security → WAF → Custom rules → Create rule
2. Field: `User Agent` · Operator: `equals` · Value: `DomainHealthCheck/2.0`
3. Action: **Skip** → ติ๊ก All remaining custom rules, Super Bot Fight Mode (และ Browser Integrity Check ถ้ามี) → Deploy

ถ้าใช้ Bot Fight Mode แบบฟรี (ไม่มีตัวเลือก Skip) ต้องปิด Bot Fight Mode ของโดเมนนั้นแทน

## สิ่งที่ปรับปรุง v0.3

- แจ้งเตือน Telegram ทั้งตอน cron ตรวจและตอนกดตรวจเอง (เดิมกดตรวจเองแล้วสถานะเปลี่ยนเงียบ ทำให้ cron ไม่แจ้ง)
- เปลี่ยนสถานะแบบ compare-and-set: ตรวจพร้อมกันสองทางก็แจ้งแค่ครั้งเดียว
- Cron จองโดเมนก่อนตรวจ: cron ซ้อนกันไม่ตรวจโดเมนเดียวกันซ้ำ
- `domain_checks.source` (`manual` / `cron`): ผลตรวจของ cron ไม่กินโควตา 30 ครั้ง/ชม. ของการกดเอง
- เทียบ `CRON_SECRET` แบบ timing-safe, ตั้ง `maxDuration` ให้ cron ไม่โดนตัดกลางทาง
- ไม่ log error object ดิบ (กัน Telegram token หลุดลง log)
- เพิ่ม `.gitignore`, `.env.example`, Prettier (`npm run format`)

## สิ่งที่ปรับปรุง v0.2

- Login only; เพิ่ม `.gitignore` และแยก Audit logic ไป `lib/audit.ts`
- จำกัดเวลารวมตรวจ 10 วินาที / 5 redirect hops
- Postgres atomic RPC `claim_domain_check`: 1 ครั้ง / 60 วินาที / โดเมน, รวม 30 ครั้งต่อชั่วโมง / เจ้าของ (สำหรับตรวจด้วยมือ)
- Cron ตรวจเป็นรอบ ไม่เกิน 10 โดเมนที่ยังเฝ้าระวังและถึงกำหนด ผ่าน `CRON_SECRET`
- ส่ง Telegram เฉพาะการเปลี่ยนสถานะ known `ok` ↔ `issue` ไม่แจ้งครั้งแรกหรือ HEAD 405/501
- ปุ่มเปิด/ปิดการเฝ้าระวังรายโดเมน

## ข้อควรระวังและข้อจำกัด

- การตรวจแบบ HEAD ไม่ยืนยันผลการเปิดหน้าแบบ GET และ HTTP 403 อาจเกิดจาก Bot Protection; ระบุว่าเป็นปัญหาที่ต้องตรวจ ไม่ใช่สรุปว่าผู้ใช้เปิดไม่ได้
- Cron และการตรวจด้วยมือยังเป็นคนละเส้นทางการจอง; หากเกิดพร้อมกันอาจบันทึกผลซ้ำได้ ระบบนี้ยังไม่เหมาะกับการสแกนถี่จำนวนมาก
- การตรวจ DNS ก่อน fetch ยังมีความเสี่ยง DNS rebinding ระหว่างขั้นตอน resolve และ fetch; จึง **เหมาะกับโดเมนที่เจ้าของควบคุมเท่านั้น** ไม่ควรให้ผู้ใช้ทั่วไปเพิ่มปลายทางได้ก่อนทำ IP pinning ในตัวเชื่อมต่อ
- บันทึก incident เฉพาะ URL/หลักฐานสาธารณะ ห้ามบันทึกรหัสผ่าน ข้อมูลการเงินหรือข้อมูลส่วนบุคคล
- ระบบไม่ได้รับประกันอันดับ Google หรือทำให้โดเมนใหม่ติด Google ทันที
- ถ้า Vercel Cron ไม่แสดงผล ให้ตรวจว่า plan รองรับ schedule นี้และตั้งค่า Secret ใน Production แล้ว

## ทดสอบที่ยังต้องทำหลัง Deploy

- `npm run build` และ `npm run lint` บนเครื่องที่ติดตั้ง dependencies ได้
- เปิด UI และทดสอบ login / add domain / toggle monitoring
- Cron ที่ไม่ส่ง Bearer Secret ต้องได้ 401 และ cron ที่ถูกต้องต้องบันทึกผล
- กดตรวจ 5 ครั้งพร้อมกัน เฉพาะครั้งแรกควรสำเร็จ ที่เหลือ 429
- เตือน Telegram เมื่อ `ok` → `issue` และเมื่อ `issue` → `ok` เพียงครั้งเดียว

ก่อนอัปเดตจริง ให้บันทึกสำเนาฐานข้อมูล Supabase หรือ snapshot schema ไว้ด้วย
