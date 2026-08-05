'use strict';

/* เรขาคณิตของหน้าปัด: ส่วนโค้ง 220 องศา */
const CX = 93, CY = 92, R = 70, A0 = 200, A1 = -20;
const ARC_LEN = R * ((A0 - A1) * Math.PI) / 180;
const pt = (deg) => [CX + R * Math.cos((deg * Math.PI) / 180), CY - R * Math.sin((deg * Math.PI) / 180)];
const ARC_D = (() => {
  const [x0, y0] = pt(A0), [x1, y1] = pt(A1);
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 1 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
})();

let state = { providers: [], updatedAt: 0 };
let config = null;

/* ---------- ตัวช่วยจัดรูปแบบ ---------- */
const fmtTokens = (n) => {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
};
function fmtCountdown(ms) {
  if (ms === null || ms === undefined || ms < 0) return '--:--';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const level = (pct) => (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '');
const dtLocal = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

/* ---------- วาดการ์ด ---------- */
function ticks() {
  let s = '';
  for (let i = 0; i <= 10; i++) {
    const a = A0 - ((A0 - A1) * i) / 10;
    const [x1, y1] = pt(a);
    const rr = i % 5 === 0 ? 9 : 5;
    const x2 = CX + (R - rr) * Math.cos((a * Math.PI) / 180);
    const y2 = CY - (R - rr) * Math.sin((a * Math.PI) / 180);
    s += `<line class="tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke-width="${i % 5 === 0 ? 1.6 : 1}"/>`;
  }
  return s;
}

/* ---------- มาสคอตประจำผู้ให้บริการ (SVG วาดเอง ไม่พึ่ง asset ภายนอก) ---------- */
function mascotFace(mood, cy, gap = 3.5) {
  const exL = 18 - gap, exR = 18 + gap;
  const eyes = mood === 'sleep'
    ? `<path class="eyelid" d="M${exL - 1.6} ${cy} q1.6 1.8 3.2 0"/><path class="eyelid" d="M${exR - 1.6} ${cy} q1.6 1.8 3.2 0"/>`
    : `<circle class="eye" cx="${exL}" cy="${cy}" r="1.6"/><circle class="eye" cx="${exR}" cy="${cy}" r="1.6"/>`;
  const my = cy + 4;
  const mouth = mood === 'sad'
    ? `<path class="mouth" d="M${18 - 2.8} ${my + 1} Q18 ${my - 1.8} ${18 + 2.8} ${my + 1}"/>`
    : mood === 'worry'
    ? `<path class="mouth" d="M${18 - 2.6} ${my} L${18 + 2.6} ${my}"/>`
    : `<path class="mouth" d="M${18 - 2.8} ${my - 0.6} Q18 ${my + 2} ${18 + 2.8} ${my - 0.6}"/>`;
  const cheeks = `<circle class="cheek" cx="${exL - 3.4}" cy="${cy + 3}" r="1.5"/><circle class="cheek" cx="${exR + 3.4}" cy="${cy + 3}" r="1.5"/>`;
  const sweat = mood === 'sad' ? `<path class="sweat" d="M28.5 ${cy - 6} q2.4 3.4 0 4.8 q-2.4 -1.4 0 -4.8"/>` : '';
  return eyes + mouth + cheeks + sweat;
}

function mascotSvg(id, mood) {
  if (id === 'claude') {
    // ประกายดาวสีส้ม
    return `<svg viewBox="0 0 36 36" aria-hidden="true">
      <path class="body" d="M18 2 C20.5 11 25 15.5 34 18 C25 20.5 20.5 25 18 34 C15.5 25 11 20.5 2 18 C11 15.5 15.5 11 18 2 Z"/>
      ${mascotFace(mood, 16.5)}
    </svg>`;
  }
  if (id === 'chatgpt') {
    // ต้นกล้าสีเขียว
    return `<svg viewBox="0 0 36 36" aria-hidden="true">
      <path class="leaf" d="M18 8 C18 3.5 21.5 1.5 25 1.5 C25 6 21.5 8 18 8 Z"/>
      <path class="leaf l2" d="M18 8 C18 4.5 15 3 12 3 C12 6.5 15 8 18 8 Z"/>
      <circle class="body" cx="18" cy="21.5" r="12.5"/>
      ${mascotFace(mood, 20)}
    </svg>`;
  }
  // grok — ยูเอฟโอสีม่วง
  return `<svg viewBox="0 0 36 36" aria-hidden="true">
    <line class="ant" x1="18" y1="7" x2="18" y2="4"/>
    <circle class="ant-tip" cx="18" cy="3" r="1.5"/>
    <circle class="body" cx="18" cy="16" r="8.5"/>
    ${mascotFace(mood, 14.5, 3)}
    <ellipse class="saucer" cx="18" cy="25" rx="14.5" ry="5"/>
    <circle class="lamp" cx="7.5" cy="24.5" r="1.2"/>
    <circle class="lamp l2" cx="18" cy="27" r="1.2"/>
    <circle class="lamp l3" cx="28.5" cy="24.5" r="1.2"/>
  </svg>`;
}

function cardHtml(p) {
  const accent = p.accent || '#8ea2c0';
  if (p.state !== 'ok') {
    const msg = p.message || 'ไม่พบข้อมูล';
    return `
    <section class="card" style="--accent:${accent}" data-id="${p.id}">
      <div class="card-head">
        <div class="mascot m-${p.id}">${mascotSvg(p.id, 'sleep')}</div>
        <div><div class="n">${p.name}</div><div class="s">${p.subtitle || ''}</div></div>
      </div>
      <div class="empty">
        <div class="big">◌</div>
        <p>${msg}</p>
        <button class="btn" data-act="settings">เปิดหน้าตั้งค่า</button>
      </div>
    </section>`;
  }

  // การ์ดที่ปักหมุดด้วยมือ (เช่น Grok) ให้เกจหลักโชว์ % รายสัปดาห์จากเว็บแทนบล็อก 5 ชม.
  const pct = p.manual ? p.weekly.pct : p.session.pct;
  const gaugeLabel = p.manual ? 'รายสัปดาห์ · จากเว็บ' : 'บล็อก 5 ชั่วโมง';
  const off = ARC_LEN * (1 - Math.min(1, pct / 100));
  const spark = p.spark || [];
  const peak = Math.max(1, ...spark);
  const bars = spark
    .map((v, i) => `<i class="${i === spark.length - 1 ? 'now' : ''}" style="height:${Math.max(2, (v / peak) * 26)}px"></i>`)
    .join('');
  const eta = p.manual
    ? 'ตามหน้าเว็บผู้ให้บริการ'
    : p.live && pct === 0 && !p.session.tokens
    ? 'โควตาเต็ม ยังไม่ใช้รอบนี้ ✦'
    : p.estimating
    ? 'กำลังเรียนรู้พฤติกรรมการใช้'
    : p.etaMs
    ? `เต็มใน ~${fmtCountdown(p.etaMs)}`
    : 'อัตราคงที่';

  const mood = pct >= 90 ? 'sad' : pct >= 70 ? 'worry' : 'happy';
  return `
  <section class="card" style="--accent:${accent}" data-id="${p.id}">
    <div class="card-head">
      <div class="mascot m-${p.id} ${mood}">${mascotSvg(p.id, mood)}</div>
      <div><div class="n">${p.name}</div><div class="s">${p.subtitle || ''}</div></div>
      ${p.live ? '<span class="live-dot" title="% ทางการจากผู้ให้บริการโดยตรง">● สด</span>' : p.liveError ? `<span class="live-dot err" title="${p.liveError}">ค่าประมาณ</span>` : p.manual ? '<span class="live-dot man" title="ปักหมุดจากเว็บด้วยมือ — อัปเดตได้ในหน้าตั้งค่า">ปักหมุด</span>' : ''}
      <button class="pill" data-act="plan" title="${p.calibrated ? 'ลิมิตมาจากการปรับเทียบกับ % จริง' : 'เปลี่ยนแพลนได้ในหน้าตั้งค่า'}">${p.planLabel}${p.calibrated ? ' ✓' : ''}</button>
    </div>

    <div class="minigauge">
      <svg viewBox="0 0 60 60">
        <circle class="ring-bg" cx="30" cy="30" r="25"/>
        <circle class="ring-fg" cx="30" cy="30" r="25"
          stroke-dasharray="157.1" stroke-dashoffset="${(157.1 * (1 - Math.min(1, pct / 100))).toFixed(1)}"
          style="${pct >= 90 ? 'stroke:var(--danger)' : pct >= 70 ? 'stroke:var(--warn)' : ''}"/>
      </svg>
      <b>${Math.round(pct)}<i>%</i></b>
    </div>

    <div class="gauge">
      <svg viewBox="0 0 186 118" aria-label="ใช้ไป ${Math.round(pct)} เปอร์เซ็นต์">
        ${ticks()}
        <path class="arc-bg" d="${ARC_D}" fill="none" stroke-width="9" stroke-linecap="round"/>
        <path class="arc-fg" d="${ARC_D}" fill="none" stroke-width="9" stroke-linecap="round"
              stroke-dasharray="${ARC_LEN.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
              style="${pct >= 90 ? 'stroke:var(--danger)' : pct >= 70 ? 'stroke:var(--warn)' : ''}"/>
      </svg>
      <div class="gauge-val">
        <b>${Math.round(pct)}<i>%</i></b>
        <span>${gaugeLabel}</span>
      </div>
    </div>

    <div class="rows">
      <div class="row">
        <div class="l"><span>บล็อกปัจจุบัน</span><em>${fmtTokens(p.session.tokens)} / ${fmtTokens(p.session.limit)}</em></div>
        <div class="bar ${level(pct)}"><i style="width:${Math.min(100, pct)}%"></i></div>
      </div>
      <div class="row">
        <div class="l"><span>รายสัปดาห์</span><em>${p.manual ? Math.round(p.weekly.pct) + '% จากเว็บ' : `${fmtTokens(p.weekly.tokens)} / ${fmtTokens(p.weekly.limit)}`}</em></div>
        <div class="bar ${level(p.weekly.pct)}"><i style="width:${Math.min(100, p.weekly.pct)}%"></i></div>
      </div>
    </div>

    <div class="spark">${bars}</div>

    <div class="foot">
      <span class="k">รีเซ็ตอีก</span>
      <span class="t" data-reset="${p.session.resetAt || p.weekly.resetAt || ''}">--:--</span>
      <span class="k" style="margin-left:12px">${eta}</span>
    </div>
  </section>`;
}

function render() {
  const grid = document.getElementById('grid');
  grid.innerHTML = state.providers.map(cardHtml).join('');
  const t = new Date(state.updatedAt || Date.now());
  document.getElementById('updated').textContent =
    'อัปเดต ' + t.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const active = state.providers.filter((p) => p.state === 'ok').length;
  document.getElementById('head-sub').textContent = `${active}/${state.providers.length} แหล่งข้อมูลพร้อมใช้งาน`;
  tick();
  paintTray();
}

/* นับถอยหลังทุกวินาที โดยไม่ต้องวาดการ์ดใหม่ */
function tick() {
  const now = Date.now();
  document.querySelectorAll('[data-reset]').forEach((n) => {
    const at = Number(n.dataset.reset);
    n.textContent = at ? fmtCountdown(at - now) : '--:--';
  });
}
setInterval(tick, 1000);

/* ---------- ไอคอนถาดระบบพร้อมตัวเลข % ---------- */
function paintTray() {
  const top = state.providers.filter((p) => p.state === 'ok').sort((a, b) => b.session.pct - a.session.pct)[0];
  const cv = document.getElementById('tray-canvas');
  const g = cv.getContext('2d');
  const pct = top ? Math.round(top.session.pct) : 0;
  const color = !top ? '#7c8aa1' : pct >= 90 ? '#ff6b6b' : pct >= 70 ? '#f5c451' : top.accent;
  g.clearRect(0, 0, 32, 32);
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(1, 1, 30, 30, 8);
  g.fill();
  g.fillStyle = '#0b0e13';
  g.font = '600 ' + (pct >= 100 ? '15px' : '18px') + ' Bahnschrift, Segoe UI, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(Math.min(999, pct)), 16, 17);
  window.api?.sendTrayIcon(cv.toDataURL('image/png'));
}

/* ---------- หน้าประวัติ: กราฟแท่งซ้อน SVG ล้วน ---------- */
let curView = 'grid';
let hMode = 'daily';
let historyData = null;

async function openHistory() {
  historyData = await window.api.getHistory();
  drawHistory();
}

/** จัดข้อมูลรายชั่วโมงลงช่องตามโหมด (รายวัน 30 ช่อง / รายชั่วโมง 48 ช่อง) */
function seriesFor(mode) {
  const slots = historyData.slots || {};
  const now = Date.now();
  const bins = [];
  const index = new Map();
  if (mode === 'hourly') {
    const start = Math.floor(now / 3600000) * 3600000 - 47 * 3600000;
    for (let i = 0; i < 48; i++) {
      const t = start + i * 3600000;
      const b = { label: `${String(new Date(t).getHours()).padStart(2, '0')}:00`, per: {} };
      bins.push(b);
      index.set(t, b);
    }
  } else {
    const d0 = new Date(now);
    d0.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const t = d0.getTime() - i * 86400000;
      const b = { label: new Date(t).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }), per: {} };
      bins.push(b);
      index.set(t, b);
    }
  }
  for (const p of historyData.providers) {
    const slot = slots[p.id] || {};
    for (const [k, v] of Object.entries(slot)) {
      const ms = Number(k);
      let key = ms;
      if (mode !== 'hourly') {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        key = d.getTime();
      }
      const b = index.get(key);
      if (b) b.per[p.id] = (b.per[p.id] || 0) + v;
    }
  }
  return bins;
}

function drawHistory() {
  if (!historyData) return;
  const provs = historyData.providers;
  const bins = seriesFor(hMode);
  const W = 720, H = 280, padL = 48, padR = 8, padT = 12, padB = 26;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...bins.map((b) => provs.reduce((s, p) => s + (b.per[p.id] || 0), 0)));
  const iw = (W - padL - padR) / bins.length;
  const bw = Math.max(2, iw * 0.66);
  let out = '';
  for (const f of [0, 0.5, 1]) {
    const y = padT + plotH * (1 - f);
    out += `<line class="h-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
    out += `<text class="h-y" x="${padL - 6}" y="${(y + 3).toFixed(1)}">${fmtTokens(max * f)}</text>`;
  }
  const labelEvery = hMode === 'hourly' ? 6 : 5;
  bins.forEach((b, i) => {
    const x = padL + i * iw + (iw - bw) / 2;
    let y = H - padB;
    for (const p of provs) {
      const v = b.per[p.id] || 0;
      const h = plotH * (v / max);
      if (h < 0.5) continue;
      y -= h;
      out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${p.accent}" rx="1.5" opacity="0.92"><title>${b.label} — ${p.name}: ${fmtTokens(v)} token</title></rect>`;
    }
    if (i % labelEvery === 0) {
      out += `<text class="h-x" x="${(padL + i * iw + iw / 2).toFixed(1)}" y="${H - 8}">${b.label}</text>`;
    }
  });
  document.getElementById('h-chart').innerHTML = out;
  document.getElementById('h-legend').innerHTML = provs
    .map((p) => `<span><b style="background:${p.accent}"></b>${p.name}</span>`)
    .join('');
}

function switchView(v) {
  curView = v;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.view === v));
  document.getElementById('grid').hidden = v !== 'grid';
  document.getElementById('history').hidden = v !== 'history';
  if (v === 'history') openHistory();
}
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
document.querySelectorAll('.seg-b').forEach((b) => {
  b.onclick = () => {
    hMode = b.dataset.mode;
    document.querySelectorAll('.seg-b').forEach((x) => x.classList.toggle('active', x === b));
    drawHistory();
  };
});

/* ---------- หน้าตั้งค่า ---------- */
const PLANS = [
  ['auto', 'อัตโนมัติ (P90)'],
  ['pro', 'Pro'],
  ['max5', 'Max 5x'],
  ['max20', 'Max 20x'],
  ['plus', 'Plus']
];

function calNoteHtml(p) {
  const c = p.calibration;
  if (c && (c.session || c.weekly)) {
    const parts = [];
    if (c.session) parts.push(`บล็อก ≈ ${fmtTokens(c.session)}`);
    if (c.weekly) parts.push(`สัปดาห์ ≈ ${fmtTokens(c.weekly)}`);
    return `ลิมิตที่ปรับเทียบแล้ว: ${parts.join(' · ')} <button class="btn cal-clear" data-act="cal-clear">ล้างค่า</button>`;
  }
  return 'เปิดหน้า usage ของผู้ให้บริการ แล้วกรอก % ที่เห็นจริง — แอปจะคำนวณลิมิตจริงย้อนกลับให้';
}

function renderSettings() {
  const box = document.getElementById('prov-settings');
  box.innerHTML = Object.values(config.providers)
    .map(
      (p) => `
    <div class="pgroup" data-id="${p.id}">
      <h3><b style="background:${p.accent}"></b>${p.name} <span style="color:var(--dim);font-weight:400">${p.subtitle}</span></h3>
      <div class="field">
        <label>แพลน / วิธีคิดลิมิต</label>
        <select data-f="plan">${PLANS.map((x) => `<option value="${x[0]}" ${p.plan === x[0] ? 'selected' : ''}>${x[1]}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label>โฟลเดอร์ log</label>
        <div class="path-row">
          <input type="text" data-f="root" value="${(p.roots[0] || '').replace(/"/g, '&quot;')}">
          <button class="btn" data-act="pick">เลือก…</button>
        </div>
      </div>
      <div class="field">
        <label>ปรับเทียบกับ % จริง</label>
        <div class="cal-row">
          <input type="number" data-f="cal-session" placeholder="% บล็อกปัจจุบัน" min="0.1" max="100" step="0.1">
          <input type="number" data-f="cal-weekly" placeholder="% รายสัปดาห์" min="0.1" max="100" step="0.1">
          <button class="btn" data-act="calibrate">ปรับเทียบ</button>
        </div>
        <p class="cal-note" data-role="cal-note">${calNoteHtml(p)}</p>
      </div>
      ${p.id === 'claude' ? `
      <div class="field" style="margin-bottom:8px">
        <label class="toggle"><input type="checkbox" data-f="live" ${p.liveUsage ? 'checked' : ''}><i class="sw"></i>ดึง % ทางการจาก claude.ai (เรียลไทม์)</label>
        <p class="cal-note">เมื่อเปิด แอปจะอ่าน token ของ Claude Code ในเครื่อง แล้วต่อเน็ตหา Anthropic
        ที่เดียวเท่านั้นเพื่อถาม % ทางการ — เป็นข้อยกเว้นเดียวจากกฎออฟไลน์ของแอป ปิดได้ตลอดเวลา</p>
      </div>` : ''}
      ${p.id !== 'claude' ? `
      <div class="field">
        <label>ปักหมุด % จากหน้าเว็บ (รายสัปดาห์)</label>
        <div class="cal-row">
          <input type="number" data-f="man-pct" placeholder="% ที่ใช้ไป" min="0" max="100" step="0.1" value="${p.manual?.pct ?? ''}">
          <input type="datetime-local" data-f="man-reset" value="${dtLocal(p.manual?.resetAt)}">
          <button class="btn" data-act="pin">ปักหมุด</button>
        </div>
        <p class="cal-note" data-role="man-note">${
          p.manual && p.manual.resetAt > Date.now()
            ? `ปักไว้ ${p.manual.pct}% รีเซ็ต ${new Date(p.manual.resetAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })} <button class="btn cal-clear" data-act="man-clear">ล้างค่า</button>`
            : p.manual
            ? 'รอบที่ปักไว้หมดแล้ว — เปิดหน้า Usage บนเว็บดู % ใหม่แล้วปักอีกครั้ง <button class="btn cal-clear" data-act="man-clear">ล้างค่า</button>'
            : 'เปิดหน้า Usage บนเว็บของผู้ให้บริการ แล้วคัดลอก % ที่ใช้ไปกับเวลารีเซ็ตมากรอก (โควตาฝั่งเว็บมองไม่เห็นจากในเครื่อง)'
        }</p>
      </div>` : ''}
      <label class="toggle"><input type="checkbox" data-f="enabled" ${p.enabled ? 'checked' : ''}><i class="sw"></i>เปิดใช้งานการ์ดนี้</label>
    </div>`
    )
    .join('');
}

async function boot() {
  config = await window.api.getConfig();
  document.getElementById('t-mini').checked = !!config.miniMode;
  document.body.classList.toggle('mini', !!config.miniMode);
  document.getElementById('t-taskbar').checked = config.showInTaskbar;
  document.getElementById('t-top').checked = config.alwaysOnTop;
  document.getElementById('t-boot').checked = config.startWithWindows;
  document.getElementById('s-refresh').value = config.refreshSeconds;
  document.getElementById('s-alert').value = config.alertThreshold;
  document.getElementById('s-weekly').value = config.weeklyMode;
  const op = Math.round((config.miniOpacity ?? 1) * 100);
  document.getElementById('s-opacity').value = op;
  document.getElementById('s-opacity-val').textContent = op + '%';
  renderSettings();
}

/* ---------- เหตุการณ์ ---------- */
document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'settings') document.getElementById('sheet').classList.add('open');

  if (act === 'plan') {
    // เดิมคลิกแล้วสลับแพลนทันที — โดนเผลอคลิกบ่อยจนค่าคลาดเคลื่อน
    // เปลี่ยนเป็นเปิดหน้าตั้งค่าให้ไปเลือกอย่างตั้งใจแทน
    document.getElementById('sheet').classList.add('open');
  }

  if (act === 'pick') {
    const group = e.target.closest('.pgroup');
    const dir = await window.api.pickFolder();
    if (dir) {
      group.querySelector('[data-f=root]').value = dir;
      config = await window.api.setProvider(group.dataset.id, { roots: [dir] });
    }
  }

  if (act === 'calibrate') {
    const group = e.target.closest('.pgroup');
    const sPct = parseFloat(group.querySelector('[data-f=cal-session]').value) || 0;
    const wPct = parseFloat(group.querySelector('[data-f=cal-weekly]').value) || 0;
    const note = group.querySelector('[data-role=cal-note]');
    if (sPct <= 0 && wPct <= 0) {
      note.textContent = 'กรอก % อย่างน้อยหนึ่งช่อง (เช่น 14 ถ้าหน้า usage บอก 14%)';
      return;
    }
    const res = await window.api.calibrate(group.dataset.id, { sessionPct: sPct, weeklyPct: wPct });
    if (res.ok) {
      config = res.config;
      renderSettings();
    } else {
      note.textContent = res.message;
    }
  }

  if (act === 'cal-clear') {
    const group = e.target.closest('.pgroup');
    config = await window.api.setProvider(group.dataset.id, { calibration: null });
    renderSettings();
  }

  if (act === 'pin') {
    const group = e.target.closest('.pgroup');
    const pctV = parseFloat(group.querySelector('[data-f=man-pct]').value);
    const rsV = group.querySelector('[data-f=man-reset]').value;
    const note = group.querySelector('[data-role=man-note]');
    const resetAt = rsV ? new Date(rsV).getTime() : NaN;
    if (!(pctV >= 0 && pctV <= 100)) {
      note.textContent = 'กรอก % ระหว่าง 0–100';
      return;
    }
    if (!(resetAt > Date.now())) {
      note.textContent = 'เลือกเวลารีเซ็ตที่ยังมาไม่ถึง (ดูจากหน้า Usage ของ grok.com)';
      return;
    }
    config = await window.api.setProvider(group.dataset.id, { manual: { pct: pctV, resetAt, at: Date.now() } });
    renderSettings();
  }

  if (act === 'man-clear') {
    const group = e.target.closest('.pgroup');
    config = await window.api.setProvider(group.dataset.id, { manual: null });
    renderSettings();
  }
});

document.getElementById('b-set').onclick = () => document.getElementById('sheet').classList.add('open');
document.getElementById('s-close').onclick = () => document.getElementById('sheet').classList.remove('open');
document.getElementById('sheet').onclick = (e) => {
  if (e.target.id === 'sheet') e.target.classList.remove('open');
};
document.getElementById('b-refresh').onclick = () => window.api.refresh();
document.getElementById('b-csv').onclick = () => window.api.exportCsv();

document.getElementById('w-min').onclick = () => window.api.window('minimize');
document.getElementById('w-max').onclick = () => window.api.window('maximize');
document.getElementById('w-close').onclick = () => window.api.window('close');
document.getElementById('w-mini').onclick = () => window.api.window('mini');
document.getElementById('mini-restore').onclick = () => window.api.window('mini');

const setCfg = async (patch) => (config = await window.api.setConfig(patch));
document.getElementById('t-mini').onchange = (e) => window.api.setMini(e.target.checked);
document.getElementById('t-taskbar').onchange = (e) => setCfg({ showInTaskbar: e.target.checked });
document.getElementById('t-top').onchange = (e) => setCfg({ alwaysOnTop: e.target.checked });
document.getElementById('t-boot').onchange = (e) => setCfg({ startWithWindows: e.target.checked });
document.getElementById('s-refresh').onchange = (e) => setCfg({ refreshSeconds: Number(e.target.value) });
document.getElementById('s-alert').onchange = (e) => setCfg({ alertThreshold: Number(e.target.value) });
document.getElementById('s-weekly').onchange = (e) => setCfg({ weeklyMode: e.target.value });
document.getElementById('s-opacity').oninput = (e) => {
  document.getElementById('s-opacity-val').textContent = e.target.value + '%';
  setCfg({ miniOpacity: Number(e.target.value) / 100 });
};

document.addEventListener('change', async (e) => {
  const group = e.target.closest('.pgroup');
  if (!group) return;
  const f = e.target.dataset.f;
  if (f === 'plan') config = await window.api.setProvider(group.dataset.id, { plan: e.target.value });
  if (f === 'live') config = await window.api.setProvider(group.dataset.id, { liveUsage: e.target.checked });
  if (f === 'enabled') config = await window.api.setProvider(group.dataset.id, { enabled: e.target.checked });
  if (f === 'root') config = await window.api.setProvider(group.dataset.id, { roots: [e.target.value] });
});

window.api.onUsage((d) => {
  state = d;
  render();
  if (curView === 'history') openHistory(); // กราฟตามข้อมูลใหม่ทุกรอบรีเฟรช
});
window.api.onMiniMode((on) => {
  document.body.classList.toggle('mini', on);
  document.getElementById('t-mini').checked = on;
  if (on) switchView('grid'); // โหมดมินิแสดงเฉพาะการ์ด
});

boot();
