'use strict';
/**
 * report.js — สร้างรายงานสรุปรายเดือนเป็นไฟล์ HTML หน้าเดียว
 * ธีมเดียวกับแอป เปิดในเบราว์เซอร์และสั่งพิมพ์เป็น PDF ได้ (มี @media print)
 * ไม่พึ่งไฟล์/ฟอนต์ภายนอกใด ๆ — ทำงานออฟไลน์ตามกฎของแอป
 */

function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildReport(config, slots, now = new Date()) {
  const provs = Object.values(config.providers).filter((p) => p.enabled);
  const y = now.getFullYear(), m = now.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const monthName = now.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

  // จัดยอดรายชั่วโมงลงรายวันของเดือนนี้
  const days = Array.from({ length: daysInMonth }, (_, i) => ({ d: i + 1, per: {} }));
  for (const p of provs) {
    for (const [k, v] of Object.entries(slots[p.id] || {})) {
      const dt = new Date(Number(k));
      if (dt.getFullYear() === y && dt.getMonth() === m) {
        const b = days[dt.getDate() - 1];
        b.per[p.id] = (b.per[p.id] || 0) + v;
      }
    }
  }

  const totals = {};
  let grand = 0, grandCost = 0;
  for (const p of provs) {
    const t = days.reduce((s, b) => s + (b.per[p.id] || 0), 0);
    totals[p.id] = t;
    grand += t;
    const rate = Number(config.pricing?.[p.id]);
    if (rate > 0) grandCost += (t / 1e6) * rate;
  }

  // กราฟแท่งซ้อน SVG
  const W = 860, H = 300, padL = 52, padR = 10, padT = 14, padB = 26;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...days.map((b) => provs.reduce((s, p) => s + (b.per[p.id] || 0), 0)));
  const iw = (W - padL - padR) / daysInMonth;
  const bw = Math.max(3, iw * 0.62);
  let chart = '';
  for (const f of [0, 0.5, 1]) {
    const yy = padT + plotH * (1 - f);
    chart += `<line class="g" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>`;
    chart += `<text class="ty" x="${padL - 6}" y="${yy + 3}">${fmtTok(max * f)}</text>`;
  }
  days.forEach((b, i) => {
    const x = padL + i * iw + (iw - bw) / 2;
    let yy = H - padB;
    for (const p of provs) {
      const v = b.per[p.id] || 0;
      const h = plotH * (v / max);
      if (h < 0.5) continue;
      yy -= h;
      chart += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${p.accent}" rx="1.5" opacity="0.92"><title>วันที่ ${b.d} — ${esc(p.name)}: ${fmtTok(v)}</title></rect>`;
    }
    if (b.d === 1 || b.d % 5 === 0) chart += `<text class="tx" x="${(padL + i * iw + iw / 2).toFixed(1)}" y="${H - 8}">${b.d}</text>`;
  });

  const legend = provs.map((p) => `<span><i style="background:${p.accent}"></i>${esc(p.name)}</span>`).join('');

  const totalRows = provs.map((p) => {
    const rate = Number(config.pricing?.[p.id]);
    const cost = rate > 0 ? (totals[p.id] / 1e6) * rate : null;
    return `<tr><td><i class="dot" style="background:${p.accent}"></i>${esc(p.name)} <small>${esc(p.subtitle || '')}</small></td>
      <td class="num">${fmtTok(totals[p.id])}</td>
      <td class="num">${cost != null ? '฿' + (cost >= 100 ? Math.round(cost).toLocaleString() : cost.toFixed(2)) : '—'}</td></tr>`;
  }).join('');

  const dayRows = days.filter((b) => provs.some((p) => b.per[p.id])).map((b) => {
    const cells = provs.map((p) => `<td class="num">${b.per[p.id] ? fmtTok(b.per[p.id]) : '·'}</td>`).join('');
    const sum = provs.reduce((s, p) => s + (b.per[p.id] || 0), 0);
    return `<tr><td>${b.d}</td>${cells}<td class="num"><b>${fmtTok(sum)}</b></td></tr>`;
  }).join('');

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<title>TokenGauge — รายงาน ${esc(monthName)}</title>
<style>
:root{--bg:#0b0e13;--panel:#151b25;--line:rgba(255,255,255,.09);--text:#e8eef7;--muted:#7c8aa1;--dim:#56637a;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Segoe UI Variable Text','Segoe UI','Leelawadee UI',system-ui,sans-serif;padding:36px 28px;}
.wrap{max-width:920px;margin:0 auto}
h1{font-family:'Bahnschrift','Segoe UI Semibold',sans-serif;font-size:26px;margin:0}
.sub{color:var(--muted);margin:6px 0 24px;font-size:13.5px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:18px}
.legend{display:flex;gap:16px;color:var(--muted);font-size:12.5px;margin-bottom:10px}
.legend i{width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:6px}
svg{width:100%;height:auto;display:block}
.g{stroke:var(--line)} .ty{fill:var(--dim);font-size:10px;text-anchor:end;font-family:Consolas,monospace}
.tx{fill:var(--dim);font-size:10px;text-anchor:middle}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-weight:600;font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums;font-family:Consolas,monospace;font-size:12.5px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px}
small{color:var(--dim)}
.note{color:var(--dim);font-size:12px;line-height:1.7}
.grand{font-size:15px}
@media print{
  body{background:#fff;color:#1d2534;padding:10mm}
  :root{--panel:#fff;--line:#d8dee8;--text:#1d2534;--muted:#56657d;--dim:#8592a6}
  .panel{border-color:#d8dee8}
}
</style></head><body><div class="wrap">
<h1>TOKENGAUGE — รายงานการใช้ AI</h1>
<div class="sub">ประจำเดือน${esc(monthName)} · สร้างเมื่อ ${esc(now.toLocaleString('th-TH', { dateStyle: 'long', timeStyle: 'short' }))}</div>

<div class="panel">
  <div class="legend">${legend}</div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟการใช้งานรายวัน">${chart}</svg>
</div>

<div class="panel">
  <table>
    <tr><th>ผู้ให้บริการ</th><th class="num">token (ถ่วงน้ำหนัก)</th><th class="num">ค่าใช้จ่ายโดยประมาณ</th></tr>
    ${totalRows}
    <tr class="grand"><td><b>รวม</b></td><td class="num"><b>${fmtTok(grand)}</b></td><td class="num"><b>${grandCost > 0 ? '฿' + Math.round(grandCost).toLocaleString() : '—'}</b></td></tr>
  </table>
</div>

<div class="panel">
  <table>
    <tr><th>วันที่</th>${provs.map((p) => `<th class="num">${esc(p.name)}</th>`).join('')}<th class="num">รวม</th></tr>
    ${dayRows || '<tr><td colspan="9">ยังไม่มีข้อมูลในเดือนนี้</td></tr>'}
  </table>
</div>

<p class="note">ตัวเลขเป็นจำนวน token ถ่วงน้ำหนัก (cache read × 0.1) ที่นับจาก log ในเครื่อง
และค่าใช้จ่ายเป็น<b>ค่าประมาณ</b>ตามตารางราคาที่ตั้งไว้ในแอป ไม่ใช่ยอดเรียกเก็บจริงของผู้ให้บริการ ·
พิมพ์หน้านี้เป็น PDF ได้ด้วย Ctrl+P</p>
</div></body></html>`;
}

module.exports = { buildReport };
