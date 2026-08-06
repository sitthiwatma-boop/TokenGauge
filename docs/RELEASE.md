# วิธีปล่อยเวอร์ชันใหม่ของ TokenGauge — ทีละขั้น

คู่มือนี้สำหรับปล่อยแอปให้คนอื่นดาวน์โหลด พร้อม auto-update ผ่าน GitHub Releases
(ไม่ต้องมีเซิร์ฟเวอร์ของตัวเอง — GitHub แจกไฟล์ให้ฟรี)

---

## เตรียมครั้งแรกครั้งเดียว

1. **สร้าง repository บน GitHub** ชื่อ `tokengauge` (public ก็ได้ private ก็ได้
   แต่ auto-update จาก repo private ต้องใช้ token ฝั่งผู้ใช้ — แนะนำ public)
2. แก้ `package.json` ตรง `build.publish` — เปลี่ยน `YOUR-GITHUB-USERNAME`
   เป็นชื่อผู้ใช้ GitHub จริงของคุณ
3. push โค้ดขึ้น GitHub:
   ```powershell
   git remote add origin https://github.com/<ชื่อคุณ>/tokengauge.git
   git push -u origin master
   ```
4. สร้าง **Personal Access Token** สำหรับอัปโหลดไฟล์อัตโนมัติ:
   GitHub → Settings → Developer settings → Personal access tokens →
   Generate new token (classic) → ติ๊กสิทธิ์ `repo` → คัดลอกเก็บไว้

---

## ปล่อยเวอร์ชันใหม่ (ทำทุกครั้ง)

1. **อัปเดตเลขเวอร์ชัน** ใน `package.json` เช่น `1.0.0` → `1.1.0`
   (auto-update เทียบเลขนี้ ถ้าไม่ขยับ ผู้ใช้จะไม่ได้อัปเดต)
2. **รันเทสต์ให้ผ่านก่อนเสมอ**:
   ```powershell
   npm test
   ```
3. **commit + ติดแท็ก**:
   ```powershell
   git add -A
   git commit -m "v1.1.0: <สรุปสิ่งที่เปลี่ยน>"
   git tag v1.1.0
   git push origin master --tags
   ```
4. **สร้างไฟล์ .exe และอัปโหลดขึ้น GitHub Releases ในคำสั่งเดียว**:
   ```powershell
   $env:GH_TOKEN = "<token ที่คัดลอกไว้>"
   npx electron-builder --win --publish always
   ```
   เสร็จแล้วจะได้ Release พร้อมไฟล์ติดตั้ง `.exe`, ตัว portable
   และไฟล์ `latest.yml` (ตัวนี้สำคัญ — auto-update ใช้เช็คเวอร์ชัน อย่าลบ)
5. เข้าไปที่หน้า Releases บน GitHub → กด **Publish release** (ถ้ายังเป็น draft)

ผู้ใช้ที่ติดตั้งเวอร์ชันเก่าอยู่ จะได้รับอัปเดตอัตโนมัติภายในไม่กี่นาที
หลังเปิดแอป (ดาวน์โหลดเบื้องหลัง แล้วติดตั้งตอนปิดโปรแกรม)

---

## สร้างไฟล์ทดสอบในเครื่อง (ไม่อัปโหลด)

```powershell
npm run build   # ได้ทั้งตัวติดตั้ง NSIS และ portable ใน dist/
npm run pack    # ได้เฉพาะ portable .exe เร็วกว่า
```

## ปัญหาที่เจอแล้วในเครื่องนี้ + วิธีแก้

การ build ครั้งแรกจะพังด้วยข้อความ `Cannot create symbolic link : A required
privilege is not held by the client` — เพราะ electron-builder ต้องแตกไฟล์
เครื่องมือที่ใช้ symbolic link ซึ่ง Windows ไม่อนุญาตโดยค่าเริ่มต้น

**วิธีแก้ที่ใช้จริงแล้ว (6 ส.ค. 2026 — build เต็มผ่านโดยไม่ต้องเปิด Developer Mode):**
แตกไฟล์เครื่องมือลง cache เอง โดยข้าม symlink ฝั่ง macOS ที่ Windows ไม่ใช้:
```powershell
$cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
$dest  = "$cache\winCodeSign-2.6.0"
New-Item -ItemType Directory -Force $dest | Out-Null
Invoke-WebRequest "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z" -OutFile "$cache\winCodeSign-2.6.0.7z"
& "node_modules\7zip-bin\win\x64\7za.exe" x -y -bd "$cache\winCodeSign-2.6.0.7z" "-o$dest"
```
(7za จะฟ้อง error 2 บรรทัดเรื่อง symlink ของ .dylib — ไม่เป็นไร ไฟล์ที่เหลือครบ)
ทำครั้งเดียว หลังจากนั้น `npm run build` ผ่านตลอด ได้ไอคอนถูกต้องครบ

**ทางเลือกอื่น:** เปิด Developer Mode (Settings → System → For developers)
แล้ว build ใหม่ — ได้ผลเหมือนกันโดยไม่ต้องแตกไฟล์เอง

## สิ่งที่ต้องรู้

- **auto-update ต่อเน็ตหา GitHub เท่านั้น** และทำงานเฉพาะตัวที่แพ็กเป็น .exe แล้ว
  (`npm start` ระหว่างพัฒนาไม่เช็คอัปเดต) ผู้ใช้ปิดได้โดยแก้ `autoUpdate: false`
  ใน config.json
- ไฟล์ .exe ไม่ได้เซ็นลายเซ็นดิจิทัล (code signing มีค่าใช้จ่ายรายปี)
  Windows SmartScreen จะเตือนตอนติดตั้งครั้งแรก — กด "More info → Run anyway"
  แจ้งผู้ใช้ไว้ในหน้าเว็บ/README ด้วย
- ไอคอน `assets/icon.png` เป็น 256×256 ตรงตามที่ electron-builder ต้องการแล้ว
