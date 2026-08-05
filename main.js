'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const cfgStore = require('./src/config');
const usage = require('./src/usage');
const liveusage = require('./src/liveusage');
const history = require('./src/history');

let win = null;
let tray = null;
let config = null;
let timer = null;
let miniMode = false;
let miniPosTimer = null;
const alertState = new Map(); // key = id:resetAt → { eta, th } เตือนได้สูงสุด 2 ครั้งต่อบล็อก

const ICON = path.join(__dirname, 'assets', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0B0E13',
    frame: false,
    show: false,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (config.miniMode) setMini(true);
  });
  win.on('close', (e) => {
    // ปิดหน้าต่าง = ย่อลง tray ไม่ใช่ออกจากโปรแกรม
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));

  // จำตำแหน่งวิดเจ็ตที่ผู้ใช้ลากไว้ (บันทึกแบบหน่วง กันเขียนไฟล์รัวระหว่างลาก)
  win.on('moved', () => {
    if (!miniMode || !win) return;
    config.miniPos = win.getPosition();
    clearTimeout(miniPosTimer);
    miniPosTimer = setTimeout(() => cfgStore.save(app, config), 1000);
  });

  win.setSkipTaskbar(!config.showInTaskbar);
  win.setAlwaysOnTop(!!config.alwaysOnTop);
}

function createTray() {
  let img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('TokenGauge');
  tray.on('click', () => {
    if (!win) return createWindow();
    win.isVisible() ? win.hide() : (win.show(), win.focus());
  });
  rebuildTrayMenu();
}

const OPACITY_STEPS = [
  { label: 'ทึบ 100%', value: 1 },
  { label: '85%', value: 0.85 },
  { label: '70%', value: 0.7 },
  { label: '55%', value: 0.55 },
  { label: 'จาง 40%', value: 0.4 }
];

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'เปิดหน้าต่าง', click: () => (win ? (win.show(), win.focus()) : createWindow()) },
      { label: 'รีเฟรชเดี๋ยวนี้', click: () => pushUsage(true) },
      { type: 'separator' },
      {
        label: 'โหมดมินิ (ลอยหน้าจอ)',
        type: 'checkbox',
        checked: miniMode,
        click: () => setMini(!miniMode)
      },
      {
        label: 'ความเข้มวิดเจ็ต',
        submenu: OPACITY_STEPS.map((s) => ({
          label: s.label,
          type: 'radio',
          checked: Math.abs((config.miniOpacity ?? 1) - s.value) < 0.01,
          click: () => setMiniOpacity(s.value)
        }))
      },
      {
        label: config.muteUntil && Date.now() < config.muteUntil
          ? `เปิดเสียงเตือน (ปิดถึง ${new Date(config.muteUntil).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })})`
          : 'ปิดเสียงเตือน 1 ชั่วโมง',
        click: () => {
          const muted = config.muteUntil && Date.now() < config.muteUntil;
          config.muteUntil = muted ? 0 : Date.now() + 3600000;
          cfgStore.save(app, config);
          rebuildTrayMenu();
        }
      },
      { type: 'separator' },
      { label: 'ออกจากโปรแกรม', click: () => (app.isQuitting = true, app.quit()) }
    ])
  );
}

function setMiniOpacity(v) {
  config.miniOpacity = v;
  cfgStore.save(app, config);
  if (win && miniMode) win.setOpacity(v);
  rebuildTrayMenu();
}

const MINI_W = 380, MINI_H = 168, MINI_GAP = 12;

/** ตำแหน่งยังอยู่บนจอไหนสักจออยู่ไหม (กันจอที่เคยต่อไว้ถูกถอด) */
function posOnScreen(pos) {
  if (!Array.isArray(pos) || pos.length !== 2) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return pos[0] >= a.x - 60 && pos[0] < a.x + a.width - 120 &&
           pos[1] >= a.y - 20 && pos[1] < a.y + a.height - 60;
  });
}

function setMini(on) {
  miniMode = on;
  if (!win) return;
  if (on) {
    win.setResizable(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    // ต้องปลดขนาดขั้นต่ำก่อน ไม่งั้น setSize โดนดีดกลับไป 720x520
    win.setMinimumSize(1, 1);
    win.setSize(MINI_W, MINI_H);
    // ใช้ตำแหน่งที่ผู้ใช้ลากไว้ล่าสุด ถ้ายังอยู่ในจอ — ไม่งั้นเกาะมุมขวาล่างเหนือ taskbar
    const wa = screen.getPrimaryDisplay().workArea;
    const fallback = [wa.x + wa.width - MINI_W - MINI_GAP, wa.y + wa.height - MINI_H - MINI_GAP];
    const pos = posOnScreen(config.miniPos) ? config.miniPos : fallback;
    win.setPosition(pos[0], pos[1]);
    win.setOpacity(Number(config.miniOpacity) || 1);
    win.show();
  } else {
    win.setResizable(true);
    win.setAlwaysOnTop(!!config.alwaysOnTop);
    win.setMinimumSize(720, 520);
    win.setSize(1080, 720);
    win.setOpacity(1);
    win.center();
  }
  win.webContents.send('mini-mode', on);
  // จำสถานะไว้ เปิดแอปใหม่จะกลับมาเป็นวิดเจ็ตเหมือนเดิม
  if (config.miniMode !== on) {
    config.miniMode = on;
    cfgStore.save(app, config);
  }
  rebuildTrayMenu();
}

/* ---------- วงจรอ่านข้อมูล ---------- */

async function pushUsage() {
  if (!win || win.isDestroyed()) return;
  let data;
  try {
    data = usage.computeAll(config);
  } catch (err) {
    data = { updatedAt: Date.now(), providers: [], error: String(err.message || err) };
  }
  // opt-in: ทับตัวเลขประมาณด้วย % ทางการจาก API (เฉพาะการ์ด Claude)
  if (config.providers.claude?.liveUsage) {
    const p = data.providers.find((x) => x.id === 'claude');
    if (p && p.ok) {
      try {
        applyLive(p, await liveusage.fetchLive());
      } catch (err) {
        p.liveError = String(err.message || err);
      }
    }
  }
  // ChatGPT: % ทางการจาก rate_limits ใน log ของ Codex เอง — อ่านในเครื่องล้วน ไม่ต่อเน็ต
  {
    const cp = config.providers.chatgpt;
    const p = data.providers.find((x) => x.id === 'chatgpt');
    if (cp?.enabled && p && p.ok) {
      try {
        const live = liveusage.fetchCodexLive(cp.roots);
        if (live) applyLive(p, live);
      } catch { /* ใช้ค่าประมาณต่อ */ }
    }
  }
  // ปักหมุดด้วยมือ (เช่น Grok จากเว็บ) — ใช้เฉพาะการ์ดที่ไม่มีแหล่งข้อมูลสด
  for (const p of data.providers) {
    const m = config.providers[p.id]?.manual;
    if (!m || p.live || !p.ok) continue;
    if (!(m.resetAt > Date.now())) {
      // รอบที่ปักไว้หมดแล้ว — เตือนครั้งเดียวให้ไปปักใหม่ แล้วกลับไปใช้ค่าประมาณ
      if (!m.notified) {
        m.notified = true;
        cfgStore.save(app, config);
        if (Notification.isSupported()) {
          new Notification({
            title: `${p.name}: รอบโควตาใหม่เริ่มแล้ว`,
            body: 'ค่าที่ปักหมุดไว้หมดรอบ — เปิดหน้า Usage บนเว็บ แล้วปักหมุด % ใหม่ได้ในหน้าตั้งค่า',
            icon: ICON
          }).show();
        }
      }
      continue;
    }
    p.weekly.pct = Math.max(0, Math.min(999, Number(m.pct) || 0));
    p.weekly.resetAt = m.resetAt;
    p.manual = true;
  }
  // บันทึกประวัติรายชั่วโมง แล้วให้กราฟ 24 ชม. อ่านจากประวัติแทน — ข้อมูลไม่หายแม้ log ถูกลบ
  history.record(app, data.providers);
  const slots = history.slots(app);
  const m0 = new Date();
  m0.setDate(1);
  m0.setHours(0, 0, 0, 0);
  for (const p of data.providers) {
    if (!p.ok) continue;
    const bins = history.sparkFrom(app, p.id);
    if (bins) p.spark = bins;
    delete p.hourly; // ใช้ภายใน ไม่ต้องส่งไป renderer
    // ยอดสะสมเดือนนี้ + ค่าใช้จ่ายโดยประมาณ (บาท) ตามตารางราคาใน config
    let mt = 0;
    for (const [k, v] of Object.entries(slots[p.id] || {})) {
      if (Number(k) >= m0.getTime()) mt += v;
    }
    p.monthTokens = mt;
    const rate = Number(config.pricing?.[p.id]);
    if (rate > 0) p.monthCostTHB = (mt / 1e6) * rate;
  }
  if (!win || win.isDestroyed()) return;
  win.webContents.send('usage', data);
  updateTrayTitle(data);
  checkAlerts(data);
  dailySummaryCheck();
}

/** แทน % ประมาณด้วย % ทางการ แล้วคำนวณลิมิตย้อนกลับจาก token ที่นับได้ */
function applyLive(p, live) {
  if (live.session) {
    p.session.pct = live.session.pct;
    if (live.session.resetAt) p.session.resetAt = live.session.resetAt;
    if (p.session.tokens > 0 && live.session.pct >= 1) {
      p.session.limit = Math.round(p.session.tokens / (live.session.pct / 100));
    }
    if (p.burnPerHour > 0) {
      const remain = p.session.limit - p.session.tokens;
      p.etaMs = remain > 0 ? (remain / p.burnPerHour) * 3600000 : 0;
    }
  }
  if (live.weekly) {
    p.weekly.pct = live.weekly.pct;
    if (live.weekly.resetAt) p.weekly.resetAt = live.weekly.resetAt;
    if (p.weekly.tokens > 0 && live.weekly.pct >= 1) {
      p.weekly.limit = Math.round(p.weekly.tokens / (live.weekly.pct / 100));
    }
  }
  p.live = true;
}

function updateTrayTitle(data) {
  if (!tray) return;
  const parts = data.providers
    .filter((p) => p.ok)
    .map((p) => `${p.name} ${Math.round(p.session.pct)}%`);
  const text = parts.length ? parts.join(' · ') : 'ยังไม่มีข้อมูล';
  tray.setToolTip(`TokenGauge — ${text}`);
  if (win && !win.isDestroyed()) win.setTitle(`TokenGauge — ${text}`);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

/** เตือนสูงสุด 2 ครั้งต่อบล็อก: (1) ตามอัตราการใช้ — จะเต็มในไม่ถึง 30 นาที (2) แตะเกณฑ์ % */
function checkAlerts(data) {
  if (config.muteUntil && Date.now() < config.muteUntil) return; // ปิดเสียงชั่วคราวอยู่
  const th = config.alertThreshold;
  for (const p of data.providers) {
    if (!p.ok || !p.session.resetAt) continue;
    const key = `${p.id}:${p.session.resetAt}`;
    const st = alertState.get(key) || { eta: false, th: false };
    const pct = p.session.pct;
    if (!st.th && pct >= th) {
      st.th = true;
      notify(
        `${p.name} ใช้ไปแล้ว ${Math.round(pct)}%`,
        `เหลือโควตาบล็อกนี้อีก ${Math.max(0, 100 - Math.round(pct))}% — รีเซ็ตในอีก ${fmtEta(p.session.resetAt - Date.now())}`
      );
    } else if (!st.eta && !st.th && p.etaMs && p.etaMs < 30 * 60000 && pct >= 40) {
      // ต้องใช้ไปพอสมควร (≥40%) ก่อน ไม่งั้น eta ต้นบล็อกจะแกว่งจนเตือนมั่ว
      st.eta = true;
      notify(
        `${p.name}: จะเต็มใน ~${Math.max(1, Math.round(p.etaMs / 60000))} นาที ถ้าใช้อัตรานี้`,
        `ตอนนี้ ${Math.round(pct)}% — บล็อกรีเซ็ตในอีก ${fmtEta(p.session.resetAt - Date.now())}`
      );
    }
    alertState.set(key, st);
  }
}

function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

/** สรุปประจำวัน — เด้งครั้งเดียวในชั่วโมงที่ตั้งไว้ เทียบค่าเฉลี่ย 7 วันจาก history */
function dailySummaryCheck() {
  const ds = config.dailySummary || {};
  if (ds.enabled === false) return;
  const now = new Date();
  if (now.getHours() !== (ds.hour ?? 21)) return;
  const stamp = now.toDateString();
  if (config.dailySummaryLast === stamp) return;
  config.dailySummaryLast = stamp;
  cfgStore.save(app, config);

  const slots = history.slots(app);
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const parts = [];
  for (const p of Object.values(config.providers)) {
    if (!p.enabled) continue;
    const slot = slots[p.id] || {};
    let today = 0, past7 = 0;
    for (const [k, v] of Object.entries(slot)) {
      const ms = Number(k);
      if (ms >= d0.getTime()) today += v;
      else if (ms >= d0.getTime() - 7 * 86400000) past7 += v;
    }
    const avg = past7 / 7;
    if (today > 0 || avg > 100) parts.push(`${p.name} ${fmtTok(today)} (เฉลี่ย ${fmtTok(avg)}/วัน)`);
  }
  if (parts.length) notify('สรุปการใช้ AI วันนี้', parts.join(' · '));
}

function fmtEta(ms) {
  if (!ms || ms < 0) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h} ชม. ${m} นาที` : `${m} นาที`;
}

function restartTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(pushUsage, Math.max(10, config.refreshSeconds) * 1000);
}

/* ---------- IPC ---------- */

ipcMain.handle('get-config', () => config);

ipcMain.handle('set-config', (_e, patch) => {
  config = { ...config, ...patch };
  cfgStore.save(app, config);
  if (win) {
    win.setSkipTaskbar(!config.showInTaskbar);
    if (!miniMode) win.setAlwaysOnTop(!!config.alwaysOnTop);
    if (miniMode && 'miniOpacity' in patch) win.setOpacity(Number(config.miniOpacity) || 1);
  }
  if ('miniOpacity' in patch) rebuildTrayMenu(); // ให้ radio ใน tray ตรงกับค่าล่าสุด
  app.setLoginItemSettings({ openAtLogin: !!config.startWithWindows });
  restartTimer();
  pushUsage();
  return config;
});

ipcMain.handle('set-provider', (_e, { id, patch }) => {
  config.providers[id] = { ...config.providers[id], ...patch };
  cfgStore.save(app, config);
  pushUsage();
  return config;
});

ipcMain.handle('refresh', () => (pushUsage(), true));

// ข้อมูลสำหรับหน้าประวัติ — สรุปรายชั่วโมงจาก history.json
ipcMain.handle('get-history', () => ({
  providers: Object.values(config.providers)
    .filter((p) => p.enabled)
    .map((p) => ({ id: p.id, name: p.name, accent: p.accent })),
  slots: history.slots(app)
}));

// ปรับเทียบลิมิตกับ % จริงจากหน้า usage ของผู้ให้บริการ
// ผู้ใช้กรอก % ที่เห็นจริง แล้วคำนวณลิมิตย้อนกลับ: limit = tokens ÷ (pct/100)
ipcMain.handle('calibrate', (_e, { id, sessionPct, weeklyPct }) => {
  const p = config.providers[id];
  if (!p) return { ok: false, message: 'ไม่พบผู้ให้บริการ' };

  const r = usage.computeProvider(p, cfgStore.PLAN_PRESETS, { weeklyMode: config.weeklyMode });
  if (!r.ok) return { ok: false, message: 'ยังไม่มีข้อมูลการใช้งาน ปรับเทียบไม่ได้' };

  const cal = { ...(p.calibration || {}) };
  if (sessionPct > 0) {
    if (r.session.tokens <= 0) return { ok: false, message: 'บล็อกปัจจุบันยังไม่มีการใช้งาน — ใช้งานสักครู่แล้วค่อยปรับเทียบ' };
    cal.session = Math.round(r.session.tokens / (sessionPct / 100));
  }
  if (weeklyPct > 0) {
    if (r.weekly.tokens <= 0) return { ok: false, message: 'สัปดาห์นี้ยังไม่มีการใช้งาน — ปรับเทียบรายสัปดาห์ไม่ได้' };
    cal.weekly = Math.round(r.weekly.tokens / (weeklyPct / 100));
  }
  if (!cal.session && !cal.weekly) return { ok: false, message: 'กรอก % อย่างน้อยหนึ่งช่อง (1–100)' };
  cal.at = Date.now();

  config.providers[id] = { ...p, calibration: cal };
  cfgStore.save(app, config);
  pushUsage();
  return { ok: true, calibration: cal, config };
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('export-csv', async () => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `tokengauge-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, '\uFEFF' + usage.exportCsv(config), 'utf8');
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});

ipcMain.on('window', (_e, action) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  else if (action === 'close') win.hide();
  else if (action === 'mini') setMini(!miniMode);
});

ipcMain.on('set-mini', (_e, on) => setMini(!!on));

// ไอคอน tray แบบมีตัวเลข % วาดจาก canvas ในหน้าต่าง แล้วส่งกลับมาเป็น PNG
ipcMain.on('tray-icon', (_e, dataUrl) => {
  if (!tray || !dataUrl) return;
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (!img.isEmpty()) {
      tray.setImage(img.resize({ width: 16, height: 16 }));
      if (win && !win.isDestroyed()) win.setOverlayIcon(img.resize({ width: 16, height: 16 }), 'การใช้งานปัจจุบัน');
    }
  } catch { /* ไม่เป็นไร ใช้ไอคอนเดิมต่อ */ }
});

/* ---------- เริ่มโปรแกรม ---------- */

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => win && (win.show(), win.focus()));

  app.whenReady().then(() => {
    config = cfgStore.load(app);
    app.setLoginItemSettings({ openAtLogin: !!config.startWithWindows });
    createWindow();
    createTray();
    restartTimer();
    setTimeout(pushUsage, 600);
  });

  app.on('before-quit', () => history.flush(app)); // เขียนประวัติที่ค้างก่อนปิด

  app.on('window-all-closed', (e) => e.preventDefault()); // อยู่ใน tray ต่อ
  app.on('activate', () => (BrowserWindow.getAllWindows().length === 0 ? createWindow() : null));
}
