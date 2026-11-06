# HOTZA Control Center v0.1.2 — Dashboard TypeScript fix

เวอร์ชันนี้เป็นโปรเจกต์ครบชุด (ไม่ใช่ไฟล์ patch) อัปโหลดไฟล์ทั้งหมดขึ้น GitHub repo เดิมได้โดยไม่ต้องสร้าง Supabase project ใหม่

**สิ่งที่แก้:** `components/Dashboard.tsx` เปลี่ยนเงื่อนไขแสดงผล `redirects` ซึ่งเป็นชนิด `unknown` ให้ตรวจ `Array.isArray` และคืน JSX หรือ `null` อย่างชัดเจน เพื่อแก้ `Type unknown is not assignable to type ReactNode` ที่เกิดใน Vercel

**การทดสอบ:** ตรวจสอบไฟล์และโครงสร้างโปรเจกต์แล้ว แต่ยังไม่ได้ยืนยัน `npm run build` เพราะสภาพแวดล้อมนี้ติดตั้ง dependencies ไม่สำเร็จ หาก Build มี error เพิ่ม ให้ใช้ logs ล่าสุดเป็นข้อมูลแก้ต่อ

**อัปเดตผ่าน GitHub:** เปิด repository เดิม > Add file > Upload files > ลากไฟล์และโฟลเดอร์ *ภายใน* โปรเจกต์นี้ (ไม่สร้างโฟลเดอร์ครอบอีกชั้น) > Commit changes > ดู Vercel Deployment ล่าสุด

**ฐานข้อมูลเดิม:** ไม่จำเป็นต้องรัน `schema.sql` ซ้ำหากติดตั้งไปแล้ว และไม่ต้องส่ง Supabase secret key ให้ใคร

---

# HOTZA Control Center — MVP v0.1

ระบบเว็บส่วนตัวสำหรับบริหารรายการโดเมน ตรวจ HTTP/Redirect และบันทึกหลักฐานเว็บไซต์สวมรอย

## ทำงานได้ในรุ่นนี้
- Supabase Email/Password Authentication
- Private domains table + Row Level Security
- เพิ่ม/ลบโดเมน และกำหนด primary / legacy / watch
- คลิกตรวจ HTTPS HEAD, HTTP status และ redirect chain (สูงสุด 5 hops)
- ประวัติผลตรวจใน Supabase
- บันทึก incident หรือเว็บไซต์ต้องสงสัยพร้อม URL และบันทึกเหตุการณ์
- Dashboard สรุปสถานะจริงจากข้อมูลที่บันทึก ไม่สร้างอันดับ Google จำลอง

## ยังไม่รวมใน v0.1
- เชื่อม Google Search Console OAuth (ต้องมี Google Cloud OAuth credentials และการอนุญาตเข้าถึง Property)
- ตรวจอันดับคำค้นหาแบบสด (Search Console ไม่มีข้อมูลเรียลไทม์)
- ตรวจภาพเว็บไซต์สวมรอยอัตโนมัติ
- Scheduled monitoring / alert notifications (รุ่นนี้กดตรวจเอง)
- การแก้ไข DNS หรือเปลี่ยนโดเมนอัตโนมัติ

## Setup
1. สร้าง Supabase project > SQL Editor > วาง `supabase/schema.sql` แล้ว Run
2. Authentication > Providers > Email เปิด Email/Password; หากเป็นระบบภายในให้ปิด public signups หลังสร้างบัญชีแอดมิน
3. Copy `.env.example` เป็น `.env.local` ใส่ URL และ Supabase publishable (หรือ anon) key เท่านั้น ห้ามใส่ service_role key ฝั่ง client
4. `npm install` และ `npm run dev`
5. เปิด `http://localhost:3000` สมัคร/เข้าสู่ระบบ
6. เมื่อพร้อมใช้งาน Push ไป GitHub และ Import project ใน Vercel เพิ่ม Environment Variables สองตัวเดิมและ Deploy
7. ถ้าจะใช้ Cloudflare DNS ให้สร้าง CNAME สำหรับ subdomain แดชบอร์ด ไปยังโดเมน Vercel ตามคำแนะนำใน Vercel Domain settings และอย่าเปิดเผย keys อื่น

## การรักษาความปลอดภัยและข้อจำกัด
- RLS แยกข้อมูลตามบัญชี Supabase; ควรปิด Signup สาธารณะสำหรับระบบภายใน และเปิด MFA สำหรับแอดมินถ้ารองรับ
- API ตรวจโดเมนใช้ Bearer session token และยืนยันการเป็นเจ้าของรายการในฐานข้อมูล
- ตรวจเฉพาะ HTTPS HEAD ไม่ดึง HTML, ไม่ส่งข้อมูล login และไม่ bypass ระบบป้องกัน
- มี DNS precheck ปฏิเสธ IP ส่วนตัว/loopback แต่ไม่ใช่ SSRF hardening ที่สมบูรณ์: สำหรับ production ที่เปิดสู่สาธารณะให้ใช้ allowlist โดเมนที่พิสูจน์สิทธิ์แล้วและ egress firewall/secure proxy เพื่อป้องกัน DNS rebinding
- ตรวจได้ครั้งละ 1 โดเมนต่อคำสั่ง และพักอย่างน้อย 60 วินาทีต่อโดเมน (ควรเพิ่ม rate limit แบบรวมต่อบัญชีสำหรับ production)
- ไม่มีการรับประกันอันดับ Google และไม่ใช้สำหรับการหลบเลี่ยงมาตรการค้นหาหรือข้อกฎหมาย
- ข้อมูลที่เก็บคือ hostname, technical checks, incidents เท่านั้น ห้ามเก็บรหัสผ่านของลูกค้าหรือข้อมูลการเงินลงใน incident notes

## ขั้นต่อไปที่แนะนำ
1. เพิ่ม Google Search Console OAuth แบบ read-only และ property mapping ตาม owner
2. เพิ่ม scheduler ตรวจ DNS, TLS, redirect และ certificate expiry พร้อม notification
3. เพิ่ม incident evidence uploads (Supabase private storage, signed access)
4. เพิ่ม MFA, invite-only access, audit log, account-level rate limits, verified-domain allowlist

**เทคโนโลยี:** Next.js App Router, TypeScript, Supabase, Vercel, Cloudflare DNS (optional)
