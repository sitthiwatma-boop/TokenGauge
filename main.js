'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const cfgStore = require('./src/config');
const usage = require('./src/usage');
const liveusage = require('./src/liveusage');

let win = null;
let tray = null;
let config = null;
let timer = null;
let miniMode = false;
const alerted = new Set(); // กันแจ้งเตือนซ้ำในบล็อกเดิม

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

function setMini(on) {
  miniMode = on;
  if (!win) return;
  if (on) {
    win.setResizable(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    // ต้องปลดขนาดขั้นต่ำก่อน ไม่งั้น setSize โดนดีดกลับไป 720x520
    win.setMinimumSize(1, 1);
    win.setSize(MINI_W, MINI_H);
    // เกาะมุมขวาล่างของพื้นที่ทำงาน (เหนือ taskbar)
    const wa = screen.getPrimaryDisplay().workArea;
    win.setPosition(wa.x + wa.width - MINI_W - MINI_GAP, wa.y + wa.height - MINI_H - MINI_GAP);
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
    if (!(m.resetAt > Date.now())) continue; // รอบที่ปักไว้หมดแล้ว กลับไปใช้ค่าประมาณ
    p.weekly.pct = Math.max(0, Math.min(999, Number(m.pct) || 0));
    p.weekly.resetAt = m.resetAt;
    p.manual = true;
  }
  if (!win || win.isDestroyed()) return;
  win.webContents.send('usage', data);
  updateTrayTitle(data);
  checkAlerts(data);
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

function checkAlerts(data) {
  const th = config.alertThreshold;
  for (const p of data.providers) {
    if (!p.ok) continue;
    const key = `${p.id}:${p.session.resetAt}`;
    if (p.session.pct >= th && !alerted.has(key)) {
      alerted.add(key);
      if (Notification.isSupported()) {
        new Notification({
          title: `${p.name} ใช้ไปแล้ว ${Math.round(p.session.pct)}%`,
          body: `เหลือโควตาบล็อกนี้อีก ${Math.max(0, 100 - Math.round(p.session.pct))}% — รีเซ็ตในอีก ${fmtEta(p.session.resetAt - Date.now())}`,
          icon: ICON
        }).show();
      }
    }
    if (p.session.pct < th * 0.6) alerted.delete(key);
  }
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

  app.on('window-all-closed', (e) => e.preventDefault()); // อยู่ใน tray ต่อ
  app.on('activate', () => (BrowserWindow.getAllWindows().length === 0 ? createWindow() : null));
}
