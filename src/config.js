'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/**
 * ค่าเริ่มต้นของแต่ละผู้ให้บริการ
 *
 * aggregation:
 *   'sum'            = ทุกบรรทัดคือยอดใช้ครั้งนั้น ๆ ให้บวกสะสม (Claude Code)
 *   'cumulative-max' = ตัวเลขในไฟล์เป็นยอดสะสมของ session ให้เอาค่าสูงสุดต่อไฟล์ (Codex CLI)
 */
const DEFAULT_PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude',
    subtitle: 'Claude Code',
    accent: '#E8794A',
    enabled: true,
    roots: [path.join(HOME, '.claude', 'projects')],
    aggregation: 'sum',
    cacheReadWeight: 0.1,
    plan: 'max5',
    calibration: null, // { session, weekly, at } — ลิมิตจริงที่ผู้ใช้ปรับเทียบเอง มีค่าแล้วจะชนะ preset
    liveUsage: false, // opt-in: ดึง % ทางการจาก API ของ Anthropic (อ่าน token ของ Claude Code + ต่อเน็ต)
    windows: { session: true, weekly: true }
  },
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    subtitle: 'Codex CLI',
    accent: '#19C37D',
    enabled: true,
    roots: [path.join(HOME, '.codex', 'sessions')],
    aggregation: 'cumulative-max',
    cacheReadWeight: 0.1,
    plan: 'auto',
    calibration: null,
    liveUsage: false, // opt-in ทดลอง: ถาม % ทางการจาก backend ของ ChatGPT ด้วย token ของ Codex
    windows: { session: true, weekly: true }
  },
  grok: {
    id: 'grok',
    name: 'Grok',
    subtitle: 'Grok CLI',
    accent: '#A78BFA',
    enabled: true,
    roots: [
      path.join(HOME, '.grok', 'history'),
      path.join(HOME, '.grok'),
      path.join(HOME, '.config', 'grok')
    ],
    aggregation: 'sum',
    cacheReadWeight: 0.1,
    plan: 'auto',
    calibration: null,
    manual: null, // { pct, resetAt } — ปักหมุด % รายสัปดาห์จากเว็บด้วยมือ (Grok ไม่มีช่องทางดึงอัตโนมัติ)
    windows: { session: true, weekly: true }
  }
};

/** ลิมิตต่อบล็อก 5 ชั่วโมง (โดยประมาณ — ไม่ใช่ตัวเลขทางการ) */
const PLAN_PRESETS = {
  pro: { label: 'Pro', session: 44000, weekly: 44000 * 12 },
  max5: { label: 'Max 5x', session: 88000, weekly: 88000 * 12 },
  max20: { label: 'Max 20x', session: 220000, weekly: 220000 * 12 },
  plus: { label: 'Plus', session: 60000, weekly: 60000 * 12 },
  auto: { label: 'อัตโนมัติ (P90)', session: null, weekly: null }
};

const DEFAULTS = {
  refreshSeconds: 60,
  // ราคาโดยประมาณ "บาทต่อ 1 ล้าน token (ถ่วงน้ำหนักแคชแล้ว)" — เป็นค่าเดาหยาบ
  // ให้พอเห็นภาพ ไม่ใช่ยอดเรียกเก็บจริง แก้ตัวเลขเองได้ใน config.json
  pricing: { claude: 150, chatgpt: 100, grok: 80 },
  alertThreshold: 90,
  showInTaskbar: true,
  alwaysOnTop: false,
  startWithWindows: false,
  weeklyMode: 'rolling', // 'rolling' = ย้อนหลัง 7 วัน | 'calendar' = ตั้งแต่วันจันทร์
  miniMode: false, // วิดเจ็ตเล็กมุมขวาล่าง (จำสถานะข้ามการเปิดแอป)
  miniOpacity: 1, // ความทึบของวิดเจ็ต 0.4–1 ปรับจากเมนู tray
  miniPos: null, // [x, y] ตำแหน่งวิดเจ็ตที่ผู้ใช้ลากไว้ล่าสุด (null = มุมขวาล่าง)
  muteUntil: 0, // ปิดเสียงเตือนชั่วคราวถึงเวลานี้ (ms)
  autoUpdate: true, // เช็คเวอร์ชันใหม่จาก GitHub Releases (เฉพาะตัวที่แพ็กแล้ว ปิดได้)
  dailySummary: { enabled: true, hour: 21 }, // สรุปประจำวันเด้งแจ้งเตือน
  theme: 'system', // 'system' = ตามธีม Windows | 'dark' | 'light'
  providers: DEFAULT_PROVIDERS
};

function configPath(app) {
  return path.join(app.getPath('userData'), 'config.json');
}

function deepMerge(base, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (k in out) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function load(app) {
  try {
    const raw = fs.readFileSync(configPath(app), 'utf8');
    return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function save(app, cfg) {
  const p = configPath(app);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

module.exports = { load, save, DEFAULTS, PLAN_PRESETS, configPath };
