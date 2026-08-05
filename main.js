'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const cfgStore = require('./src/config');
const usage = require('./src/usage');

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
  win.once('ready-to-show', () => win.show());
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
      { type: 'separator' },
      { label: 'ออกจากโปรแกรม', click: () => (app.isQuitting = true, app.quit()) }
    ])
  );
}

function setMini(on) {
  miniMode = on;
  if (!win) return;
  if (on) {
    win.setResizable(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setSize(360, 190);
  } else {
    win.setResizable(true);
    win.setAlwaysOnTop(!!config.alwaysOnTop);
    win.setSize(1080, 720);
    win.center();
  }
  win.webContents.send('mini-mode', on);
  rebuildTrayMenu();
}

/* ---------- วงจรอ่านข้อมูล ---------- */

function pushUsage() {
  if (!win || win.isDestroyed()) return;
  let data;
  try {
    data = usage.computeAll(config);
  } catch (err) {
    data = { updatedAt: Date.now(), providers: [], error: String(err.message || err) };
  }
  win.webContents.send('usage', data);
  updateTrayTitle(data);
  checkAlerts(data);
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
  }
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
