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

function cardHtml(p) {
  const accent = p.accent || '#8ea2c0';
  const monogram = (p.name || '?')[0];
  if (p.state !== 'ok') {
    const msg = p.message || 'ไม่พบข้อมูล';
    return `
    <section class="card" style="--accent:${accent}" data-id="${p.id}">
      <div class="card-head">
        <div class="mark">${monogram}</div>
        <div><div class="n">${p.name}</div><div class="s">${p.subtitle || ''}</div></div>
      </div>
      <div class="empty">
        <div class="big">◌</div>
        <p>${msg}</p>
        <button class="btn" data-act="settings">เปิดหน้าตั้งค่า</button>
      </div>
    </section>`;
  }

  const pct = p.session.pct;
  const off = ARC_LEN * (1 - Math.min(1, pct / 100));
  const spark = p.spark || [];
  const peak = Math.max(1, ...spark);
  const bars = spark
    .map((v, i) => `<i class="${i === spark.length - 1 ? 'now' : ''}" style="height:${Math.max(2, (v / peak) * 26)}px"></i>`)
    .join('');
  const eta = p.estimating
    ? 'กำลังเรียนรู้พฤติกรรมการใช้'
    : p.etaMs
    ? `เต็มใน ~${fmtCountdown(p.etaMs)}`
    : 'อัตราคงที่';

  return `
  <section class="card" style="--accent:${accent}" data-id="${p.id}">
    <div class="card-head">
      <div class="mark">${monogram}</div>
      <div><div class="n">${p.name}</div><div class="s">${p.subtitle || ''}</div></div>
      <button class="pill" data-act="plan" title="${p.calibrated ? 'ลิมิตมาจากการปรับเทียบกับ % จริง' : 'คลิกเพื่อสลับแพลน'}">${p.planLabel}${p.calibrated ? ' ✓' : ''}</button>
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
        <span>บล็อก 5 ชั่วโมง</span>
      </div>
    </div>

    <div class="rows">
      <div class="row">
        <div class="l"><span>บล็อกปัจจุบัน</span><em>${fmtTokens(p.session.tokens)} / ${fmtTokens(p.session.limit)}</em></div>
        <div class="bar ${level(pct)}"><i style="width:${Math.min(100, pct)}%"></i></div>
      </div>
      <div class="row">
        <div class="l"><span>รายสัปดาห์</span><em>${fmtTokens(p.weekly.tokens)} / ${fmtTokens(p.weekly.limit)}</em></div>
        <div class="bar ${level(p.weekly.pct)}"><i style="width:${Math.min(100, p.weekly.pct)}%"></i></div>
      </div>
    </div>

    <div class="spark">${bars}</div>

    <div class="foot">
      <span class="k">รีเซ็ตอีก</span>
      <span class="t" data-reset="${p.session.resetAt || ''}">--:--</span>
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
      <label class="toggle"><input type="checkbox" data-f="enabled" ${p.enabled ? 'checked' : ''}><i class="sw"></i>เปิดใช้งานการ์ดนี้</label>
    </div>`
    )
    .join('');
}

async function boot() {
  config = await window.api.getConfig();
  document.getElementById('t-taskbar').checked = config.showInTaskbar;
  document.getElementById('t-top').checked = config.alwaysOnTop;
  document.getElementById('t-boot').checked = config.startWithWindows;
  document.getElementById('s-refresh').value = config.refreshSeconds;
  document.getElementById('s-alert').value = config.alertThreshold;
  document.getElementById('s-weekly').value = config.weeklyMode;
  renderSettings();
}

/* ---------- เหตุการณ์ ---------- */
document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'settings') document.getElementById('sheet').classList.add('open');

  if (act === 'plan') {
    // คลิกป้ายแพลนเพื่อสลับไปแพลนถัดไปอย่างรวดเร็ว
    const id = e.target.closest('.card').dataset.id;
    const cur = config.providers[id].plan;
    const i = PLANS.findIndex((x) => x[0] === cur);
    const next = PLANS[(i + 1) % PLANS.length][0];
    config = await window.api.setProvider(id, { plan: next });
    renderSettings();
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

const setCfg = async (patch) => (config = await window.api.setConfig(patch));
document.getElementById('t-taskbar').onchange = (e) => setCfg({ showInTaskbar: e.target.checked });
document.getElementById('t-top').onchange = (e) => setCfg({ alwaysOnTop: e.target.checked });
document.getElementById('t-boot').onchange = (e) => setCfg({ startWithWindows: e.target.checked });
document.getElementById('s-refresh').onchange = (e) => setCfg({ refreshSeconds: Number(e.target.value) });
document.getElementById('s-alert').onchange = (e) => setCfg({ alertThreshold: Number(e.target.value) });
document.getElementById('s-weekly').onchange = (e) => setCfg({ weeklyMode: e.target.value });

document.addEventListener('change', async (e) => {
  const group = e.target.closest('.pgroup');
  if (!group) return;
  const f = e.target.dataset.f;
  if (f === 'plan') config = await window.api.setProvider(group.dataset.id, { plan: e.target.value });
  if (f === 'enabled') config = await window.api.setProvider(group.dataset.id, { enabled: e.target.checked });
  if (f === 'root') config = await window.api.setProvider(group.dataset.id, { roots: [e.target.value] });
});

window.api.onUsage((d) => {
  state = d;
  render();
});
window.api.onMiniMode((on) => document.body.classList.toggle('mini', on));

boot();
