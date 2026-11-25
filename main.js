'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const cfgStore = require('./src/config');
const usage = require('./src/usage');
const liveusage = require('./src/liveusage');
const webquota = require('./src/webquota');
const history = require('./src/history');
const report = require('./src/report');

let win = null;
let tray = null;
let config = null;
let timer = null;
let miniMode = false;
let miniPosTimer = null;
let lastData = null; // ผลรอบล่าสุดที่ส่งเข้า renderer — ใช้ปรับเทียบให้ตรงกับที่ผู้ใช้เห็น
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

  // จำตำแหน่ง/ขนาดวิดเจ็ตที่ผู้ใช้ปรับไว้ (บันทึกแบบหน่วง กันเขียนไฟล์รัวระหว่างลาก)
  win.on('moved', () => {
    if (!miniMode || !win) return;
    config.miniPos = win.getPosition();
    clearTimeout(miniPosTimer);
    miniPosTimer = setTimeout(() => cfgStore.save(app, config), 1000);
  });
  win.on('resized', () => {
    if (!miniMode || !win) return;
    config.miniSize = win.getSize();
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
      { label: 'รีเฟรชเดี๋ยวนี้', click: () => pushUsage() },
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
    win.setAlwaysOnTop(true, 'screen-saver');
    // ต้องปลดขนาดขั้นต่ำก่อน ไม่งั้น setSize โดนดีดกลับไป 720x520
    win.setMinimumSize(240, 110);
    win.setResizable(true); // ลากมุมย่อ/ขยายวิดเจ็ตได้ เนื้อหาสเกลตามใน renderer
    const size = Array.isArray(config.miniSize) && config.miniSize[0] >= 240 ? config.miniSize : [MINI_W, MINI_H];
    win.setSize(size[0], size[1]);
    if (win.setAspectRatio) win.setAspectRatio(MINI_W / MINI_H); // ล็อกสัดส่วนตอนลาก
    // ใช้ตำแหน่งที่ผู้ใช้ลากไว้ล่าสุด ถ้ายังอยู่ในจอ — ไม่งั้นเกาะมุมขวาล่างเหนือ taskbar
    const wa = screen.getPrimaryDisplay().workArea;
    const fallback = [wa.x + wa.width - size[0] - MINI_GAP, wa.y + wa.height - size[1] - MINI_GAP];
    const pos = posOnScreen(config.miniPos) ? config.miniPos : fallback;
    win.setPosition(pos[0], pos[1]);
    win.setOpacity(Number(config.miniOpacity) || 1);
    win.show();
  } else {
    if (win.setAspectRatio) win.setAspectRatio(0);
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

/**
 * ดึงข้อมูลสดของทุกเจ้าก่อนคำนวณ — ต้องรู้ "เวลารีเซ็ตจริง" ก่อน
 * จึงจะนับ token ในเครื่องในหน้าต่างเดียวกับผู้ให้บริการได้ (ดู opts.window ใน usage.js)
 *
 * sameAccount = แหล่งข้อมูลสดมาจากบัญชีเดียวกับ log ที่เราอ่านในเครื่อง
 *   → เอาเวลารีเซ็ตไปกำหนดหน้าต่าง และคำนวณลิมิตย้อนกลับได้
 * web = โควตาจากเว็บที่ผู้ใช้ล็อกอินในแอป ซึ่งอาจเป็นคนละบัญชีกับ CLI
 *   → ตั้งได้แค่ % ห้ามแตะตัวเลข token
 */
async function collectLive() {
  const out = {};
  // Claude — API ทางการของ Anthropic (opt-in) บัญชีเดียวกับ Claude Code ที่เราอ่าน log อยู่
  if (config.providers.claude?.enabled && config.providers.claude?.liveUsage) {
    try {
      out.claude = { data: await liveusage.fetchLive(), sameAccount: true };
    } catch (err) {
      out.claude = liveFail('claude', String(err.message || err));
    }
  }
  // โควตาสดจากเว็บ (opt-in ทดลอง) ผ่าน session ที่ล็อกอินในหน้าต่างของแอป
  // Claude อยู่ในลูปนี้ด้วยแต่เป็น "ทางสำรอง" — API ทางการแม่นกว่าและถอดลิมิตกลับได้
  // จะถามเว็บเฉพาะตอน API ไม่ได้ผล (เคสหลักคือ token ของ CLI หมดอายุเพราะไม่ได้ใช้ CLI)
  for (const id of ['claude', 'chatgpt', 'gemini']) {
    const cp = config.providers[id];
    if (!cp?.enabled || !cp.liveWeb || out[id]?.data) continue;
    const prev = out[id]?.error; // เช่น API ของ Claude ล้มไปก่อนหน้าในรอบเดียวกัน
    try {
      out[id] = { data: await webquota.fetchLive(id), web: true };
    } catch (err) {
      const msg = String(err.message || err);
      out[id] = liveFail(id, prev ? `${prev} · เว็บ: ${msg}` : msg);
    }
  }
  // ChatGPT: ถ้าเว็บสดไม่ได้ผล ลอง API โดยตรง (opt-in) → ถอยไป rate_limits ใน log ของ Codex
  const cp = config.providers.chatgpt;
  if (cp?.enabled && !out.chatgpt?.data) {
    let live = null;
    let error = out.chatgpt?.error;
    if (cp.liveUsage) {
      try {
        live = await liveusage.fetchCodexApiLive();
      } catch (err) {
        error = String(err.message || err);
      }
    }
    if (!live) {
      try {
        live = liveusage.fetchCodexLive(cp.roots);
      } catch { /* ใช้ค่าประมาณต่อ */ }
    }
    if (live) out.chatgpt = { data: live, sameAccount: true };
    else if (error) out.chatgpt = liveFail('chatgpt', error);
  }
  return out;
}

/**
 * ผลลัพธ์ตอนดึงข้อมูลสดล้ม — แนบ "ค่าสดล่าสุดที่ยังอยู่ในรอบเดิม" ไปด้วยถ้ามี
 * ธง sameAccount/web ต้องยึดที่มาของ snapshot ไม่ใช่ทางที่เพิ่งล้ม เพราะค่าที่จำไว้
 * อาจมาจากเว็บ (คนละบัญชีกับ CLI ได้) ซึ่งห้ามเอาไปกำหนดหน้าต่างนับ token
 */
function liveFail(id, error) {
  const snap = liveusage.usableSnapshot(config.providers[id]?.liveSnapshot);
  return {
    error,
    stale: snap,
    sameAccount: snap?.source === 'api',
    web: snap?.source === 'web'
  };
}

/** เวลารีเซ็ตที่เชื่อถือได้พอจะใช้กำหนดหน้าต่างนับ token (เฉพาะแหล่งบัญชีเดียวกัน) */
function liveWindows(live) {
  const out = {};
  const now = Date.now();
  for (const [id, r] of Object.entries(live)) {
    if (!r?.sameAccount) continue;
    // สดล้มแต่ยังจำรอบเดิมได้ → ใช้กรอบเดียวกับผู้ให้บริการต่อ ดีกว่าถอยไปบล็อกที่ตัดเอง
    // (ถ้าเปลี่ยนกรอบกลางคัน ตัวเลข token จะกระโดดทั้งที่ผู้ใช้ไม่ได้ทำอะไร)
    const src = r.data || r.stale;
    if (!src) continue;
    // รอบที่ผ่านไปแล้วห้ามเอามาใช้ — liveusage เสิร์ฟค่าดีล่าสุดได้นานถึง 15 นาทีตอน API ล่ม
    // ถ้ารอบหมุนพอดีช่วงนั้น หน้าต่างจะปิดไปแล้วและตัดการใช้งานปัจจุบันทิ้งทั้งหมด
    // การ์ดจะแช่แข็งอยู่กับตัวเลขรอบเก่าพร้อมนับถอยหลังติดลบ
    const usable = (v) => v > now;
    const w = {};
    if (usable(src.session?.resetAt)) {
      w.session = src.session.resetAt;
      if (src.session.windowMs > 0) w.sessionMs = src.session.windowMs;
    }
    if (usable(src.weekly?.resetAt)) {
      w.weekly = src.weekly.resetAt;
      if (src.weekly.windowMs > 0) w.weeklyMs = src.weekly.windowMs;
    }
    if (w.session || w.weekly) out[id] = w;
  }
  return out;
}

let pushInFlight = null;

/**
 * ห้ามวิ่งซ้อนกัน — collectLive() รอเน็ตทีละเจ้าต่อกัน worst case ราว 80 วินาที
 * ซึ่งนานกว่ารอบรีเฟรชปกติ (60 วิ) พอเน็ตมีปัญหาจึงมีรอบค้างในอากาศหลายตัวทันที
 * รอบเก่าที่จบทีหลังจะส่งข้อมูลเก่าทับรอบใหม่ และยิงเน็ตซ้ำจนโดนจำกัดคำขอเอง
 * (cache ของ liveusage/webquota เขียนหลังคำขอเสร็จ จึงกัน stampede ไม่ได้)
 */
function pushUsage() {
  if (pushInFlight) return pushInFlight;
  pushInFlight = runPushUsage()
    .catch((err) => console.error('pushUsage ล้มเหลว:', err))
    .finally(() => { pushInFlight = null; });
  return pushInFlight;
}

async function runPushUsage() {
  if (!win || win.isDestroyed()) return;
  const live = await collectLive();
  let data;
  try {
    data = usage.computeAll(config, { liveWindows: liveWindows(live) });
  } catch (err) {
    data = { updatedAt: Date.now(), providers: [], error: String(err.message || err) };
  }
  // ทับตัวเลขประมาณด้วย % ทางการ
  for (const p of data.providers) {
    const r = live[p.id];
    if (!r || !p.ok) continue;
    if (!r.data) {
      p.liveError = r.error;
      // สดล้ม แต่รอบเดิมยังไม่รีเซ็ต → % ที่วัดได้ล่าสุดยังเป็นพื้นที่ถูกต้อง
      // (ภายในรอบเดียวกัน % มีแต่เพิ่ม) ดีกว่าดิ่งไปค่าประมาณที่ไม่รู้จักการใช้จากเว็บ
      if (r.stale) liveusage.applyStale(p, r.stale);
      continue;
    }
    if (r.web) applyLiveWeb(p, r.data);
    else applyLive(p, r.data);
    rememberLiveSnapshot(p.id, r.data, r.web ? 'web' : 'api');
    delete p.liveError;
  }
  // ปักหมุดด้วยมือ (เช่น ChatGPT จากเว็บ) — ใช้เมื่อไม่มีข้อมูลสด "รายสัปดาห์"
  // (เว็บสดอาจได้แค่โควตารอบสั้น — รายสัปดาห์ที่ปักไว้ยังต้องแสดง อย่าให้ 0% ทับ 63% แบบที่เคยพลาด)
  for (const p of data.providers) {
    const m = config.providers[p.id]?.manual;
    // เช็คที่ weekly.liveSource ไม่ใช่ webGauge — webGauge ตั้งโดย applyLiveWeb เท่านั้น
    // ทาง rate_limits ของ Codex (applyLive) จึงหลุด guard แล้วโดนค่าปักหมุดเก่าทับ
    // % ทางการที่แม่นกว่าทิ้งไปเงียบ ๆ
    if (!m || !p.ok) continue;
    // ค่าสดที่ค้างไว้ (stale) ไม่ใช่ของสด ๆ — ถ้าผู้ใช้ปักหมุดหลังจากที่วัดค่านั้นได้
    // ให้ค่าที่ "วัดทีหลัง" ชนะ ไม่งั้นค่าค้างเก่าจะบังค่าที่ผู้ใช้เพิ่งยืนยันกับหน้าเว็บ
    const staleBeaten = p.weekly.liveSource === 'stale' && (m.at || 0) > (p.weekly.staleAt || 0);
    if (p.weekly.liveSource && !staleBeaten) continue;
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
    delete p.weekly.liveSource; // ค่าปักหมุดชนะค่าค้างแล้ว อย่าให้แถบยังอ้างว่ามาจากค่าสด
    delete p.weekly.staleAt;
    p.manual = true;
    p.webGauge = true; // หน้าปัดหลักโชว์ % รายสัปดาห์ที่ปักไว้ แม้จะมีข้อมูลสดฝั่งแชท
    // มีค่าปักหมุดใช้อยู่ ป้ายเตือน API ไม่จำเป็น — ยกเว้นผู้ใช้เปิดโหมดสดไว้
    // แล้วมันล้มเหลว ต้องเห็นสาเหตุ ไม่ใช่เงียบหาย (เคยไล่บั๊กตาบอดมาแล้ว)
    const cp = config.providers[p.id];
    if (!cp?.liveWeb && !cp?.liveUsage) delete p.liveError;
  }
  // การ์ดที่มีแต่ % จากเว็บ (Gemini) แต่ยังไม่ได้ค่าสักตัว — ห้ามโชว์ 0% เหมือนเป็นของจริง
  // บอกให้ไปเปิดโหมดเว็บ/ล็อกอินแทน (ข้อความ error ของรอบนี้บอกสาเหตุได้ตรงกว่า)
  for (const p of data.providers) {
    if (!p.webOnly || !p.ok || p.session.liveSource || p.weekly.liveSource) continue;
    const cp = config.providers[p.id];
    p.ok = false;
    p.state = 'unconfigured';
    p.message = !cp?.liveWeb
      ? 'เปิด "โควตาสดจาก gemini.google.com" แล้วล็อกอินในหน้าตั้งค่า'
      : p.liveError || 'กำลังอ่านจากหน้าเว็บ…';
  }
  // ค่าที่ใช้แทนการ์ดทั้งใบ — การ์ดที่โควตาหลักมาจากเว็บให้ยึดรายสัปดาห์ ไม่ใช่บล็อก 5 ชม.
  // ต้องคิดที่เดียวแล้วส่งไปให้ทุกที่ใช้ (tray, แจ้งเตือน, หน้าปัดใน renderer)
  // ไม่งั้นแต่ละที่ตีความเองแล้วพูดคนละเรื่องกับที่การ์ดโชว์ — เคยทำให้ tray ขึ้น
  // "ChatGPT 0%" ทั้งที่การ์ดขึ้น 100% และการแจ้งเตือนไม่เคยทำงานกับการ์ดพวกนี้เลย
  for (const p of data.providers) {
    if (!p.ok) continue;
    const web = p.manual || p.webGauge;
    const w = web ? p.weekly : p.session;
    // source บอกที่มาของ "ตัวเลขที่โชว์จริง" — ป้ายบนการ์ดต้องยึดอันนี้
    // เดิมใช้ธง p.live ของทั้งการ์ด ทำให้การ์ดขึ้น "● สด" ทั้งที่ตัวเลขรายสัปดาห์
    // เป็นค่าปักหมุดจากเมื่อสองวันก่อน (ที่สดคือโควตาแชท ซึ่งไม่ใช่ตัวที่โชว์)
    p.headline = {
      window: web ? 'weekly' : 'session',
      pct: w.pct,
      resetAt: w.resetAt || null,
      source: p.manual && web ? 'manual' : w.liveSource || 'estimate',
      pinnedAt: p.manual && web ? config.providers[p.id]?.manual?.at || null : null,
      staleAt: w.liveSource === 'stale' ? w.staleAt || null : null
    };
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
  lastData = data; // ให้ IPC calibrate ปรับเทียบกับตัวเลขชุดเดียวกับที่การ์ดโชว์อยู่
  win.webContents.send('usage', data);
  updateTrayTitle(data);
  checkAlerts(data);
  dailySummaryCheck();
  scheduleLiveRetry(data);
}

/**
 * แทน % ประมาณด้วย % ทางการ แล้วคำนวณลิมิตย้อนกลับจาก token ที่นับได้
 *
 * คำนวณย้อนกลับได้เฉพาะหน้าต่างที่นับมาในกรอบเดียวกับผู้ให้บริการ (windowSource = 'live')
 * ถ้าหน้าต่างไม่ตรงกัน token กับ % จะเป็นคนละเรื่อง หารกันแล้วได้ลิมิตมั่ว
 * (เคยได้ 862M จาก 25.85M ÷ 3% เพราะฝั่งเรานับ rolling 7 วัน แต่รอบจริงเพิ่งรีเซ็ต)
 */
function applyLive(p, live) {
  const learned = {};
  if (live.session) {
    p.session.pct = live.session.pct;
    p.session.liveSource = 'api';
    if (live.session.resetAt) p.session.resetAt = live.session.resetAt;
    if (p.windowSource?.session === 'live' && p.session.tokens > 0 && live.session.pct >= 1) {
      p.session.limit = Math.round(p.session.tokens / (live.session.pct / 100));
      p.session.limitFromPct = true; // คู่ token/ลิมิตสอดคล้องกับ % ที่โชว์แล้ว
      if (live.session.pct >= LIMIT_MIN_PCT) learned.session = p.session.limit;
    }
    if (!p.session.limitFromPct) {
      // % ที่โชว์เป็นของทางการ แต่ลิมิตยังเป็นค่าประมาณในเครื่อง — เวลาที่ทำนายจาก
      // สองฐานที่ไม่ตรงกันจะขัดกับ % ในการ์ดใบเดียวกัน ไม่บอกดีกว่าบอกผิด
      p.etaMs = null;
    } else if (p.burnPerHour > 0) {
      const remain = p.session.limit - p.session.tokens;
      p.etaMs = remain > 0 ? (remain / p.burnPerHour) * 3600000 : 0;
    }
  }
  if (live.weekly) {
    p.weekly.pct = live.weekly.pct;
    p.weekly.liveSource = 'api';
    if (live.weekly.resetAt) p.weekly.resetAt = live.weekly.resetAt;
    if (p.windowSource?.weekly === 'live' && p.weekly.tokens > 0 && live.weekly.pct >= 1) {
      p.weekly.limit = Math.round(p.weekly.tokens / (live.weekly.pct / 100));
      p.weekly.limitFromPct = true;
      if (live.weekly.pct >= LIMIT_MIN_PCT) learned.weekly = p.weekly.limit;
    }
  }
  p.live = true;
  rememberLiveLimit(p.id, learned);
}

/** โควตาจากเว็บ — อาจคนละบัญชีกับ CLI จึงตั้งได้แค่ % ห้ามแตะ token หรือคำนวณลิมิตย้อนกลับ */
function applyLiveWeb(p, live) {
  const cp = config.providers[p.id];
  if (live.session) {
    p.session.pct = live.session.pct;
    p.session.liveSource = 'web';
    if (live.session.resetAt) p.session.resetAt = live.session.resetAt;
  }
  if (live.weekly) {
    p.weekly.pct = live.weekly.pct;
    p.weekly.liveSource = 'web';
    if (live.weekly.resetAt) p.weekly.resetAt = live.weekly.resetAt;
    // ฝั่งสดบางทีไม่บอกเวลารีเซ็ต — ยืมจากค่าปักหมุดที่ยังไม่หมดรอบมาโชว์นับถอยหลัง
    else if (cp?.manual?.resetAt > Date.now()) p.weekly.resetAt = cp.manual.resetAt;
  }
  p.live = true;
  // ให้หน้าปัดหลักโชว์รอบจากเว็บแบบเดียวกับปักหมุด — ยกเว้น Claude และ Gemini ที่เว็บบอก
  // รอบสั้นมาด้วย การ์ดจึงยึดรอบปัจจุบันต่อได้เหมือนโหมด API ไม่ต้องสลับหน้าปัดไปมา
  // (ChatGPT ห้ามทำแบบเดียวกัน — ฝั่งนั้น session คือโควตาแชท ไม่ใช่ตัวที่บีบจริง)
  // เงื่อนไขนี้ต้องตรงกับ applyStale ใน liveusage.js เป๊ะ ๆ
  p.webGauge = (p.id === 'claude' || p.webOnly) && live.session ? false : !!live.weekly;
}

/**
 * จำ % สดล่าสุดลง config ไว้ใช้ตอนสดล้ม — lastGood ใน liveusage อยู่แค่ในหน่วยความจำ
 * และมีอายุ 15 นาที ไม่พอกับเคสจริงที่ token หมดอายุข้ามคืนหรือปิดแอปไปแล้วเปิดใหม่
 * เขียนไฟล์เฉพาะตอนค่าขยับจริง (% ทางการเป็นจำนวนเต็ม) หรือของเดิมเก่าเกิน 15 นาที
 */
const SNAP_STALE_MS = 15 * 60 * 1000;

function rememberLiveSnapshot(id, live, source) {
  const now = Date.now();
  const cur = config.providers[id]?.liveSnapshot || {};
  const next = { source };
  let changed = cur.source !== source;
  for (const k of ['session', 'weekly']) {
    const w = live[k];
    if (!w || !isFinite(Number(w.pct))) {
      if (cur[k]) next[k] = cur[k]; // รอบนี้ไม่ได้ค่ามา ของเดิมยังอ้างอิงได้ต่อ
      continue;
    }
    next[k] = { pct: Number(w.pct), resetAt: w.resetAt || null, windowMs: w.windowMs || null, at: now };
    const o = cur[k];
    if (!o || o.pct !== next[k].pct || o.resetAt !== next[k].resetAt || now - (o.at || 0) > SNAP_STALE_MS) {
      changed = true;
    }
  }
  if (!changed || (!next.session && !next.weekly)) return;
  config.providers[id] = { ...config.providers[id], liveSnapshot: next };
  cfgStore.save(app, config);
}

/**
 * จำลิมิตที่เรียนรู้จาก % ทางการไว้ใช้ตอน API ล่ม — ดีกว่าค่า preset ที่เป็นแค่ค่าเดาหยาบ
 * เขียนไฟล์เฉพาะตอนค่าขยับเกิน 10% หรือของเดิมเก่าเกิน 6 ชม. กันเขียนทุกรอบรีเฟรช
 */
const LIMIT_STALE_MS = 6 * 3600 * 1000;
/**
 * % ทางการมาเป็นจำนวนเต็ม ยิ่ง % ต่ำยิ่งถอดลิมิตกลับได้หยาบ — เคยตั้งขั้นต่ำไว้ 10%
 * แต่กลายเป็นว่ารายสัปดาห์แทบไม่เคยถูกเรียนรู้เลยในช่วงต้นสัปดาห์ พอ API ล่มจริง
 * ค่าสำรองเลยตกไปที่ preset ซึ่งห่างจากความจริงของผู้ใช้คนนี้ราว 50 เท่า
 * (เห็นกับตา: รายสัปดาห์ขึ้น 30.25M / 1.06M = 999% แดง)
 *
 * ค่าหยาบที่ผิดสัก 2 เท่า ดีกว่า preset ที่ผิด 50 เท่ามาก จึงลดขั้นต่ำลงแล้วกันค่ากระโดด
 * ด้วยการผสมกับค่าเดิมแทน — ตัวเลขที่โชว์บนการ์ดยังเป็นค่าถอดกลับตรง ๆ ให้ตรงกับ %
 * ที่ทางการบอก ส่วนค่าที่จำไว้ใช้ยามฉุกเฉินขยับช้ากว่า
 */
const LIMIT_MIN_PCT = 2;
const blendLimit = (prev, next) => (prev > 0 ? Math.round(prev * 0.7 + next * 0.3) : next);

function rememberLiveLimit(id, learned) {
  if (!learned.session && !learned.weekly) return;
  const cur = config.providers[id]?.liveLimit || {};
  const next = { ...cur, at: Date.now() };
  if (learned.session) next.session = blendLimit(cur.session, learned.session);
  if (learned.weekly) next.weekly = blendLimit(cur.weekly, learned.weekly);
  const same = (a, b) => (!a && !b) || (a > 0 && b > 0 && Math.abs(a - b) / b <= 0.1);
  const fresh = cur.at && Date.now() - cur.at < LIMIT_STALE_MS;
  if (fresh && same(cur.session, next.session) && same(cur.weekly, next.weekly)) return;
  config.providers[id] = { ...config.providers[id], liveLimit: next };
  cfgStore.save(app, config);
}

/**
 * โหมดสดล้มตอนเปิดแอปเป็นเรื่องปกติ — "เปิดพร้อม Windows" ทำให้แอปขึ้นมาก่อนที่
 * token ของ CLI จะถูกต่ออายุ ยิงครั้งแรกเลยโดน 401 แล้วต้องรอครบ refreshSeconds
 * กว่าจะลองใหม่ (เคยค้างที่ค่าประมาณอยู่หลายนาที) จึงลองซ้ำถี่ ๆ ในช่วงแรกแทน
 */
const LIVE_RETRY_MS = [20000, 45000, 90000];
const liveRetry = new Map(); // id -> { n, timer }

/**
 * งบลองซ้ำต้องแยกรายเจ้า — ตอนใช้ key รวมของ "ชุดที่กำลังล้ม" เจ้าที่พังค้าง
 * (เช่นเว็บที่ endpoint ไม่ทางการ) ทำให้ชุดสลับไปมาจนงบถูกรีเซ็ตแทบทุกรอบ
 * แล้วลองซ้ำไม่รู้จบ ส่วนถ้าไม่รีเซ็ตเลย เจ้าที่พังค้างก็กินงบจนเจ้าอื่นไม่ได้ลอง
 * แยกรายเจ้าแล้วจบทั้งสองปัญหา: แต่ละเจ้ามีงบของตัวเอง คืนงบเมื่อกลับมาปกติ
 */
function scheduleLiveRetry(data) {
  const failing = new Set(data.providers.filter((p) => p.liveError).map((p) => p.id));
  for (const [id, st] of liveRetry) {
    if (failing.has(id)) continue;
    clearTimeout(st.timer);
    liveRetry.delete(id);
  }
  for (const id of failing) {
    let st = liveRetry.get(id);
    if (!st) liveRetry.set(id, (st = { n: 0, timer: null }));
    if (st.timer || st.n >= LIVE_RETRY_MS.length) continue;
    st.timer = setTimeout(() => {
      st.timer = null;
      pushUsage();
    }, LIVE_RETRY_MS[st.n++]);
  }
}

function updateTrayTitle(data) {
  if (!tray) return;
  const parts = data.providers
    .filter((p) => p.ok)
    .map((p) => `${p.name} ${Math.round(p.headline?.pct ?? p.session.pct)}%`);
  const text = parts.length ? parts.join(' · ') : 'ยังไม่มีข้อมูล';
  tray.setToolTip(`TokenGauge — ${text}`);
  if (win && !win.isDestroyed()) win.setTitle(`TokenGauge — ${text}`);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

/**
 * เตือนสูงสุด 2 ครั้งต่อรอบ: (1) ตามอัตราการใช้ — จะเต็มในไม่ถึง 30 นาที (2) แตะเกณฑ์ %
 *
 * ยึด p.headline ไม่ใช่ p.session — การ์ดที่โควตาหลักมาจากเว็บมี session.resetAt เป็น null
 * เลยเคยถูกข้ามทั้งใบ ไม่เตือนเลยแม้รายสัปดาห์แตะ 100% แล้ว
 */
function checkAlerts(data) {
  if (config.muteUntil && Date.now() < config.muteUntil) return; // ปิดเสียงชั่วคราวอยู่
  const th = config.alertThreshold;
  for (const p of data.providers) {
    if (!p.ok || !p.headline?.resetAt) continue;
    const { pct, resetAt, window } = p.headline;
    const rounds = window === 'weekly' ? 'รอบสัปดาห์นี้' : 'บล็อกนี้';
    // ห้ามใช้ resetAt เป็น key — ฝั่งเว็บบางเจ้าบอกเวลารีเซ็ตเป็น "อีกกี่วินาที"
    // (ดู webResetAt ใน liveusage.js) ค่าจึงขยับทุกรอบรีเฟรช ถ้าเอามาทำ key
    // จะกลายเป็นรอบใหม่ทุกครั้งแล้วเตือนซ้ำไม่หยุด — ใช้ตัว % ตกลงมาเป็นสัญญาณ
    // ว่าขึ้นรอบใหม่แทน เว้นระยะ 5% กันแกว่งไปมาแถวเกณฑ์
    const key = `${p.id}:${window}`;
    const st = alertState.get(key) || { eta: false, th: false };
    if (pct < th - 5) {
      st.th = false;
      st.eta = false;
    }
    if (!st.th && pct >= th) {
      st.th = true;
      notify(
        `${p.name} ใช้ไปแล้ว ${Math.round(pct)}%`,
        `เหลือโควตา${rounds}อีก ${Math.max(0, 100 - Math.round(pct))}% — รีเซ็ตในอีก ${fmtEta(resetAt - Date.now())}`
      );
    } else if (!st.eta && !st.th && window === 'session' && p.etaMs && p.etaMs < 30 * 60000 && pct >= 40) {
      // etaMs คำนวณจากอัตราเผาผลาญของบล็อก 5 ชม. จึงใช้ได้เฉพาะการ์ดที่ยึดบล็อกเป็นหลัก
      // ต้องใช้ไปพอสมควร (≥40%) ก่อน ไม่งั้น eta ต้นบล็อกจะแกว่งจนเตือนมั่ว
      st.eta = true;
      notify(
        `${p.name}: จะเต็มใน ~${Math.max(1, Math.round(p.etaMs / 60000))} นาที ถ้าใช้อัตรานี้`,
        `ตอนนี้ ${Math.round(pct)}% — บล็อกรีเซ็ตในอีก ${fmtEta(resetAt - Date.now())}`
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

/**
 * ล้าง calibration ของการ์ดที่เปิดโหมดสดไว้ (ครั้งเดียวตอนเปิดแอป)
 *
 * ค่าที่ปรับเทียบไว้ก่อนหน้านี้คำนวณจาก `tokens ÷ (pct/100)` โดยใช้ token
 * จากหน้าต่างที่ไม่ตรงกับรอบจริงของผู้ให้บริการ จึงเพี้ยนได้หลายเท่าและค้างถาวร
 * (เคยทำให้ Claude ขึ้นรายสัปดาห์แดง 97% ทั้งที่ทางการบอก 3%)
 * ตอนนี้โหมดสดเรียนรู้ลิมิตเองผ่าน liveLimit แล้ว ไม่ต้องพึ่งค่าปรับมืออีก
 *
 * เฉพาะ liveUsage เท่านั้น — liveWeb ไม่เคยเรียนรู้ liveLimit (applyLiveWeb ห้ามแตะ token
 * เพราะอาจคนละบัญชี) ถ้าล้าง calibration ของมันด้วย พอ session เว็บหมดอายุจะไม่เหลืออะไรเลย
 */
function dropStaleCalibration() {
  let changed = false;
  for (const p of Object.values(config.providers)) {
    if (!p.calibration || !p.liveUsage) continue;
    p.calibration = null;
    changed = true;
  }
  if (changed) cfgStore.save(app, config);
}

/* ---------- IPC ---------- */

// ลงทะเบียนเปิดพร้อม Windows เฉพาะตัวที่แพ็กเป็น .exe แล้วเท่านั้น
// ตอนรันจากซอร์ส execPath คือ electron.exe เปล่า ๆ ใน node_modules —
// ถ้าลงทะเบียนไป Windows จะเปิดหน้า welcome ของ Electron ทุกครั้งที่ล็อกอิน
function syncLoginItem() {
  app.setLoginItemSettings({
    openAtLogin: app.isPackaged && !!config.startWithWindows,
  });
}

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
  syncLoginItem();
  restartTimer();
  pushUsage();
  return config;
});

ipcMain.handle('set-provider', (_e, { id, patch }) => {
  config.providers[id] = { ...config.providers[id], ...patch };
  // เปิดโหมดสดทีหลัง = ค่าปรับเทียบเก่ายังค้างและชนะ liveLimit ตลอด ทั้งที่หน้าตั้งค่า
  // ซ่อนปุ่มล้างไปแล้ว ผู้ใช้จะติดกับ ล้างให้ตรงนี้ด้วยเหมือนที่ทำตอนบูต
  if (patch.liveUsage && config.providers[id].calibration) {
    config.providers[id].calibration = null;
  }
  // เลือกแพลนเองแล้วต้องมีผล — liveLimit ที่เรียนรู้ไว้ชนะ preset จึงต้องล้างทิ้ง
  // ไม่งั้นผู้ใช้เปลี่ยนแพลนแล้วตัวเลขไม่ขยับ โดยไม่มีอะไรบอกว่าทำไม
  if (patch.plan) config.providers[id].liveLimit = null;
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
  if (p.webOnly) return { ok: false, message: 'การ์ดนี้ใช้ % จากเว็บโดยตรง ไม่มี token ให้ปรับเทียบ' };
  // โหมดสดให้ % ทางการอยู่แล้วและแม่นกว่า — ปรับเทียบทับจะได้ลิมิตที่ค้างอยู่กับรอบเก่า
  // (liveWeb ไม่นับ เพราะมันคุมแค่รายสัปดาห์จากเว็บ ส่วนแถวบล็อกยังเป็น token ของ CLI)
  if (p.liveUsage) {
    return { ok: false, message: 'เปิดโหมดสดอยู่ — % มาจากผู้ให้บริการโดยตรงแล้ว ไม่ต้องปรับเทียบ' };
  }

  // ต้องปรับเทียบกับ "ตัวเลขที่ผู้ใช้เห็นบนการ์ด" — ถ้าคำนวณใหม่ตรงนี้จะได้คนละหน้าต่าง
  // กับที่การ์ดใช้ (การ์ดอาจนับในกรอบจากผู้ให้บริการ) แล้วลิมิตที่ถอดกลับจะผิดสัดส่วนถาวร
  const r = lastData?.providers.find((x) => x.id === id);
  if (!r?.ok) return { ok: false, message: 'ยังไม่มีข้อมูลการใช้งาน ปรับเทียบไม่ได้' };
  if (r.live) return { ok: false, message: 'การ์ดนี้ใช้ % ทางการอยู่แล้ว ไม่ต้องปรับเทียบ' };

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

// โควตาสดจากเว็บ (Claude/ChatGPT) — ล็อกอินในหน้าต่างของแอป (ดู src/webquota.js)
ipcMain.handle('web-login', async (_e, id) => {
  await webquota.openLogin(id, win);
  pushUsage();
  return webquota.hasSession(id);
});
ipcMain.handle('web-logout', async (_e, id) => {
  await webquota.logout(id);
  pushUsage();
  return true;
});
ipcMain.handle('web-test', async (_e, id) => {
  const r = await webquota.testLive(id);
  pushUsage();
  return r;
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

ipcMain.handle('export-report', async () => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `tokengauge-report-${new Date().toISOString().slice(0, 7)}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, report.buildReport(config, history.slots(app)), 'utf8');
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

/**
 * ผู้ให้บริการที่เลิกรองรับแล้ว (config.load ลบออกจาก config ให้แล้ว) — ล้างของที่ค้างในเครื่อง
 * session เว็บที่ผู้ใช้เคยล็อกอินไว้ใน partition ของแอปเอง และไฟล์ debug ที่มีข้อความจากหน้าเว็บ
 * ไม่ปล่อยค้างไว้ทั้งที่แอปไม่ใช้แล้ว ทำครั้งเดียว เพราะบันทึก config ทันทีหลังล้าง
 */
function cleanupRetired() {
  const ids = config.retired || [];
  if (!ids.length) return;
  for (const id of ids) {
    session.fromPartition(`persist:${id}web`).clearStorageData().catch(() => {});
    for (const f of [`debug-sniff-${id}.txt`, `debug-dom-${id}.txt`, `debug-webquota-${id}.txt`]) {
      try {
        fs.unlinkSync(path.join(app.getPath('userData'), f));
      } catch { /* ไม่มีไฟล์ ไม่เป็นไร */ }
    }
  }
  cfgStore.save(app, config);
}

/* ---------- เริ่มโปรแกรม ---------- */

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => win && (win.show(), win.focus()));

  app.whenReady().then(() => {
    config = cfgStore.load(app);
    cleanupRetired();
    dropStaleCalibration();
    // endpoint หน้า usage ที่เคยเรียนรู้ไว้ + จำตัวใหม่เมื่อเจอ (ดู src/webquota.js)
    for (const id of ['claude', 'chatgpt']) {
      webquota.setDiscovered(id, config.providers[id]?.liveEndpoint || null);
    }
    webquota.setOnDiscover((id, ep) => {
      config.providers[id] = { ...config.providers[id], liveEndpoint: ep };
      cfgStore.save(app, config);
      pushUsage();
    });
    syncLoginItem();
    createWindow();
    createTray();
    restartTimer();
    setTimeout(pushUsage, 600);

    // auto-update ผ่าน GitHub Releases — ทำงานเฉพาะตัวที่แพ็กเป็น .exe แล้ว
    // และปิดได้ด้วย config.autoUpdate = false (ข้อยกเว้นเรื่องต่อเน็ต ดู CLAUDE.md)
    if (app.isPackaged && config.autoUpdate !== false) {
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.on('update-downloaded', (info) => {
          notify('TokenGauge มีเวอร์ชันใหม่', `v${info.version} จะติดตั้งอัตโนมัติเมื่อปิดโปรแกรม`);
        });
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      } catch { /* ไม่มี electron-updater ก็ข้ามไป */ }
    }
  });

  app.on('before-quit', () => history.flush(app)); // เขียนประวัติที่ค้างก่อนปิด

  app.on('window-all-closed', (e) => e.preventDefault()); // อยู่ใน tray ต่อ
  app.on('activate', () => (BrowserWindow.getAllWindows().length === 0 ? createWindow() : null));
}
