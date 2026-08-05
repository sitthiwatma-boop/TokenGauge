# CLAUDE.md

ไฟล์นี้เป็นบริบทที่ Claude Code อ่านอัตโนมัติทุกครั้งที่เปิดโปรเจกต์
แก้ไขได้เรื่อย ๆ เมื่อโครงสร้างเปลี่ยน — ยิ่งไฟล์นี้ตรงกับความจริง Claude ยิ่งช่วยได้แม่น

---

## โปรเจกต์นี้คืออะไร

**TokenGauge** — แอปเดสก์ท็อป Electron บน Windows แสดงโควตาการใช้งาน AI แบบเรียลไทม์
สำหรับ Claude Code, ChatGPT (Codex CLI) และ Grok CLI

ผู้ใช้เป็นครูไทยที่เขียนโค้ดด้วย AI ทั้งวัน ต้องการรู้ในแวบเดียวว่า
"เหลือโควตาเท่าไหร่ และรีเซ็ตอีกกี่นาที" โดยไม่ต้องเปิดเว็บไปดู

**ภาษาใน UI ทั้งหมดเป็นภาษาไทย** — โค้ดและคอมเมนต์เขียนไทยได้ ตัวแปรใช้อังกฤษ

---

## หลักการที่ห้ามละเมิด

1. **ห้ามอ่านไฟล์ credential หรือ token ใด ๆ** เช่น `.credentials.json`, `auth.json`,
   Windows Credential Manager — แอปนี้อ่านเฉพาะไฟล์ `.jsonl` ที่บันทึกจำนวน token เท่านั้น
   นี่คือจุดขายด้านความปลอดภัยของแอป อย่าเพิ่มฟีเจอร์ที่ทำลายข้อนี้
2. **ห้ามส่งข้อมูลออกนอกเครื่อง** ไม่มี telemetry ไม่มี analytics ไม่มี cloud sync
   ถ้าจะเพิ่มฟีเจอร์ที่ต้องต่อเน็ต ต้องถามผู้ใช้ก่อนเสมอ
3. **`contextIsolation: true` และ `nodeIntegration: false`** ห้ามปิด
   ทุกอย่างที่ renderer ต้องใช้ ให้ผ่าน `preload.js` เท่านั้น
4. **ไม่พึ่งพา CDN หรือฟอนต์ออนไลน์** แอปต้องทำงานได้แม้ออฟไลน์
   ฟอนต์ที่ใช้มีอยู่ใน Windows อยู่แล้ว (Bahnschrift, Segoe UI, Leelawadee UI, Cascadia Mono)

---

## สถาปัตยกรรม

```
main.js          main process — หน้าต่าง, Tray, Notification, ตั้งเวลารีเฟรช, IPC handler
preload.js       contextBridge เปิด window.api ให้ renderer (จุดเดียวที่ข้ามฝั่งได้)
src/config.js    ค่าตั้งต้น + PLAN_PRESETS + โหลด/บันทึก config.json ใน userData
src/usage.js     หัวใจ — เดินหาไฟล์ .jsonl, แกะ token, จัดบล็อก 5 ชม., คำนวณ %
renderer/        UI ล้วน ไม่มี Node API
```

**การไหลของข้อมูล**
`setInterval ใน main.js` → `usage.computeAll(config)` → `win.webContents.send('usage', data)`
→ `window.api.onUsage(cb)` ใน `renderer/app.js` → `render()`

renderer ไม่เคยอ่านไฟล์เอง และ main ไม่เคยยุ่งกับ DOM — ยกเว้นกรณีเดียวคือ
ไอคอน Tray ที่วาดด้วย canvas ใน renderer แล้วส่ง dataURL กลับไปให้ main ผ่าน `sendTrayIcon`

---

## แนวคิดสำคัญใน src/usage.js

**บล็อก 5 ชั่วโมง** — เริ่มนับที่ต้นชั่วโมงของข้อความแรก แล้วยาว 5 ชั่วโมง
ถ้าเว้นว่างเกิน 5 ชั่วโมงถือว่าขึ้นบล็อกใหม่ (เลียนแบบวิธีของ ccusage)

**aggregation สองแบบ** — ต่างกันตรงนี้เท่านั้น อย่าสับสน
- `'sum'` = แต่ละบรรทัดคือยอดใช้ครั้งนั้น ให้บวกสะสม (Claude Code)
- `'cumulative-max'` = ตัวเลขในไฟล์เป็นยอดสะสมของ session ให้เอาค่าสูงสุดต่อไฟล์ (Codex CLI)
  ถ้าบวกสะสมแบบแรกจะได้ตัวเลขพองเกินจริงหลายเท่า

**การหา usage แบบยืดหยุ่น** — `findUsage()` ไล่หา object ที่มี key หน้าตาเหมือน usage
(`input_tokens`, `prompt_tokens`, `output_tokens` ฯลฯ) ลึกได้ถึง 5 ชั้น
ทำแบบนี้เพราะแต่ละเจ้าวางโครงสร้าง JSON ไม่เหมือนกันและเปลี่ยนบ่อย
**เพิ่มผู้ให้บริการใหม่ส่วนใหญ่จึงไม่ต้องแก้ตัวอ่านไฟล์เลย** แค่เพิ่ม config

**ลิมิต** — ถ้า plan เป็น `'auto'` จะใช้เปอร์เซ็นไทล์ที่ 90 ของบล็อกที่จบแล้ว
แต่ต้องมีอย่างน้อย 3 บล็อก ไม่งั้นตั้ง `estimating: true` แล้วใช้ค่าปลอดภัยแทน
(เคสนี้เคยทำให้แสดง 100% ผิด ๆ ตอนมีข้อมูลบล็อกเดียว — ระวังอย่าให้ถอยกลับไปเป็นแบบนั้น)

**ถ่วงน้ำหนัก cache read** ที่ 0.1 เท่า เพราะ token จากแคชคิดค่าถูกกว่ามาก
ค่านี้เป็นการประมาณ ปรับได้ที่ `cacheReadWeight`

**แคชไฟล์** — `fileCache` ใน memory เก็บตาม mtime + size อ่านซ้ำเฉพาะไฟล์ที่เปลี่ยน
ถ้าเพิ่มฟีเจอร์ที่ต้องอ่านข้อมูลย้อนหลังเยอะ ๆ ให้ระวังหน่วยความจำ

---

## แนวทาง UI

ธีมมืดแบบแผงหน้าปัดเครื่องวัด สิ่งที่เป็นเอกลักษณ์คือ **หน้าปัดโค้ง 220 องศาพร้อมขีดสเกล**
ถ้าจะเพิ่มอะไร ให้เก็บความสงบไว้รอบ ๆ หน้าปัด อย่าใส่ gradient หรือ animation ฟุ่มเฟือย

- สีตามผู้ให้บริการอยู่ที่ตัวแปร `--accent` ของการ์ดแต่ละใบ
- เกณฑ์สี: ปกติ → เหลือง 70% → แดง 90%
- ตัวเลขทุกตัวใช้ `font-variant-numeric: tabular-nums` ไม่งั้นตัวเลขจะกระตุกตอนนับถอยหลัง
- เคารพ `prefers-reduced-motion` อยู่แล้ว อย่าเพิ่ม animation ที่ข้ามข้อนี้

---

## คำสั่งที่ใช้บ่อย

```powershell
npm install        # ครั้งแรกครั้งเดียว
npm start          # รันแอป
npm run dev        # รันพร้อม flag --dev
npm run build      # สร้าง .exe ลงโฟลเดอร์ dist/
```

**เปิด DevTools ตอนรัน:** กด `Ctrl+Shift+I`

**ทดสอบตรรกะโดยไม่ต้องเปิดแอป** — เร็วกว่ามากเวลาดีบั๊ก `src/usage.js`

```powershell
node -e "const u=require('./src/usage');const {PLAN_PRESETS}=require('./src/config');console.log(JSON.stringify(u.computeProvider({id:'claude',name:'Claude',roots:[require('os').homedir()+'/.claude/projects'],aggregation:'sum',cacheReadWeight:0.1,plan:'max20'},PLAN_PRESETS,{weeklyMode:'rolling'}),null,2))"
```

**ดูหน้าตา UI โดยไม่ต้องเปิด Electron** — เปิด `demo.html` ในเบราว์เซอร์
ไฟล์นี้จำลอง `window.api` ไว้ให้แล้ว ถ้าแก้ `styles.css` หรือ `app.js`
ต้องสร้าง demo.html ใหม่ด้วย ไม่งั้นจะไม่ตรงกัน

---

## ข้อควรระวังที่เจอมาแล้ว

- `win.on('close')` ถูกดักไว้ให้ซ่อนลง Tray แทนการปิด ถ้าจะเพิ่มปุ่มออกจริง ๆ
  ต้องตั้ง `app.isQuitting = true` ก่อนเรียก `app.quit()`
- `nativeImage.createFromDataURL` รับ PNG dataURL เท่านั้น ใช้ SVG ไม่ได้
- Content-Security-Policy ใน `index.html` ห้าม inline script — ถ้าเพิ่ม script ต้องแยกไฟล์
- ฟอนต์ Bahnschrift มีเฉพาะ Windows 10 ขึ้นไป มี fallback ไว้แล้ว อย่าลบ
- ตัวนับถอยหลังอัปเดตด้วย `tick()` ทุกวินาที โดยไม่วาดการ์ดใหม่ทั้งใบ
  ถ้าเผลอเรียก `render()` ทุกวินาที animation ของหน้าปัดจะกระตุกตลอดเวลา

---

## วิธีทำงานร่วมกับผู้ใช้

- อธิบายเป็นภาษาไทย กระชับ ตรงประเด็น
- แก้ทีละเรื่อง ทดสอบให้เห็นผลก่อนไปเรื่องถัดไป
- ถ้าจะเปลี่ยนโครงสร้างใหญ่ บอกเหตุผลและผลกระทบก่อนลงมือ
- เมื่อเพิ่มฟีเจอร์เสร็จ อัปเดต `README.md` และไฟล์นี้ให้ตรงด้วย
