'use strict';
/**
 * build-demo.js — ประกอบ demo.html จากไฟล์จริงใน renderer/ + mock ใน scripts/demo-mock.js
 *
 * demo.html เป็นไฟล์ generate ล้วน ห้ามแก้ด้วยมือ — แก้ที่ renderer/ แล้วรัน:
 *   npm run build:demo
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const html = read('renderer', 'index.html');
const css = read('renderer', 'styles.css');
const appJs = read('renderer', 'app.js');
const mock = read('scripts', 'demo-mock.js');

const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('หา <body> ใน renderer/index.html ไม่เจอ');

// ตัด script ของแอปออก เพราะเราจะฝัง inline เอง (demo ไม่มี CSP จึงฝังได้)
const body = bodyMatch[1].replace(/[ \t]*<script src="app\.js"><\/script>\s*/g, '').trimEnd();

const out = `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<title>TokenGauge — ตัวอย่างหน้าตา</title>
<!--
  ไฟล์นี้ถูกสร้างอัตโนมัติจาก renderer/ ด้วย \`npm run build:demo\`
  ห้ามแก้ตรงนี้ — แก้ renderer/index.html, styles.css, app.js หรือ scripts/demo-mock.js แทน
-->
<style>
${css}
</style>
</head><body>
${body}

<script>
${mock}
</script>
<script>
${appJs}
</script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'demo.html'), out, 'utf8');
console.log(`สร้าง demo.html แล้ว (${Math.round(out.length / 1024)} KB)`);
