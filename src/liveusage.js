'use strict';
/**
 * liveusage.js — ดึง % โควตาทางการจาก API ของ Anthropic (ฟีเจอร์ opt-in เท่านั้น)
 *
 * นี่คือข้อยกเว้นเดียวจากกฎ "ไม่อ่าน credential / ไม่ต่อเน็ต" ของแอป
 * ผู้ใช้ต้องเปิดสวิตช์เองในหน้าตั้งค่า (ปิดเป็นค่าเริ่มต้น) เงื่อนไขที่ต้องรักษา:
 *   - อ่านเฉพาะ accessToken จาก ~/.claude/.credentials.json (ไฟล์ของ Claude Code)
 *   - ส่งไปที่ api.anthropic.com ที่เดียวเท่านั้น — endpoint เดียวกับคำสั่ง /usage ใน Claude Code
 *   - ห้าม log, เก็บ, หรือส่ง token ไปที่อื่นเด็ดขาด
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const CACHE_MS = 120 * 1000; // กันยิง API ถี่เกิน แม้ผู้ใช้ตั้งรีเฟรช 10 วิ
const STALE_MS = 15 * 60 * 1000; // ค่าดีล่าสุดยังเชื่อถือได้ภายใน 15 นาที
const BACKOFF_MS = 10 * 60 * 1000; // โดน 429 แล้วพักยาว

let cache = { at: 0, data: null, error: null };
let lastGood = { at: 0, data: null }; // เก็บผลสำเร็จล่าสุดไว้ใช้ตอน API ล่ม จะได้ไม่ดิ่งไปค่าประมาณ
let backoffUntil = 0;

function readAccessToken() {
  const p = path.join(os.homedir(), '.claude', '.credentials.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    throw new Error('ไม่พบไฟล์ credential ของ Claude Code — ล็อกอิน Claude Code ก่อน');
  }
  const j = JSON.parse(raw);
  const tok = j?.claudeAiOauth?.accessToken || j?.accessToken;
  if (!tok) throw new Error('ไม่พบ accessToken ในไฟล์ของ Claude Code');
  return tok;
}

function request(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json'
        },
        timeout: 10000
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new Error('token หมดอายุ — ใช้งาน Claude Code สักครั้งเพื่อต่ออายุ'));
          if (res.statusCode !== 200) return reject(new Error(`API ตอบ ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('อ่านคำตอบ API ไม่ได้'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('หมดเวลาเชื่อมต่อ')));
    req.on('error', () => reject(new Error('ต่ออินเทอร์เน็ตไม่ได้ — ใช้ค่าประมาณแทน')));
    req.end();
  });
}

/* โครงสร้างคำตอบเปลี่ยนได้ จึงหา key แบบยืดหยุ่นเหมือน findUsage ใน usage.js */
function windowOf(json, names) {
  for (const n of names) {
    if (json && json[n] && typeof json[n] === 'object') return json[n];
  }
  return null;
}

function normalize(w) {
  if (!w) return null;
  const pct = Number(w.utilization ?? w.used_pct ?? w.percent);
  if (!isFinite(pct)) return null;
  const reset = w.resets_at ? Date.parse(w.resets_at) : null;
  return { pct: Math.max(0, Math.min(999, pct)), resetAt: isFinite(reset) ? reset : null };
}

async function fetchLive() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) {
    if (cache.error) throw new Error(cache.error);
    if (cache.data) return cache.data;
  }
  // ช่วงพักหลังโดน 429: เสิร์ฟค่าดีล่าสุดถ้ายังไม่เก่าเกิน ไม่ยิงซ้ำ
  if (now < backoffUntil) {
    if (lastGood.data && now - lastGood.at < STALE_MS) return lastGood.data;
    throw new Error('ถูกจำกัดคำขอชั่วคราว — ใช้ค่าประมาณระหว่างรอ');
  }
  try {
    const json = await request(readAccessToken());
    const data = {
      session: normalize(windowOf(json, ['five_hour', 'fiveHour', 'session'])),
      weekly: normalize(windowOf(json, ['seven_day', 'sevenDay', 'weekly'])),
      weeklyModel: normalize(windowOf(json, ['seven_day_opus', 'seven_day_oauth_apps', 'seven_day_sonnet']))
    };
    if (!data.session && !data.weekly) throw new Error('โครงสร้างคำตอบ API ไม่ตรงที่คาด');
    cache = { at: now, data, error: null };
    lastGood = { at: now, data };
    return data;
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('429')) backoffUntil = now + BACKOFF_MS;
    // API ล่มชั่วคราว แต่ค่าดีล่าสุดยังสดพอ → ใช้ต่อ ดีกว่าสลับไปค่าประมาณที่แกว่งแรง
    if (lastGood.data && now - lastGood.at < STALE_MS) {
      cache = { at: now, data: lastGood.data, error: null };
      return lastGood.data;
    }
    cache = { at: now, data: null, error: msg };
    throw err;
  }
}

/* ---------- ChatGPT (Codex CLI) — % ทางการจาก log ในเครื่อง ไม่ต้องต่อเน็ต ----------
 * Codex CLI จด rate_limits (used_percent, resets_at) ลงไฟล์ session .jsonl เอง
 * เราแค่หาบรรทัดล่าสุด — ไฟล์ใหญ่ได้หลายร้อย MB จึงอ่านเฉพาะท้ายไฟล์
 */

function newestJsonl(roots, limit = 3) {
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && /\.jsonl$/i.test(e.name)) {
        try {
          files.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        } catch { /* ไฟล์หายระหว่างเดิน ข้ามได้ */ }
      }
    }
  };
  for (const r of roots || []) walk(r);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function readTail(file, bytes = 262144) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function mapCodexWindow(w, ts) {
  if (!w || typeof w.used_percent !== 'number') return null;
  const resetAt = w.resets_at ? w.resets_at * 1000 : ts + (w.window_minutes || 0) * 60000;
  // หน้าต่างที่รีเซ็ตไปแล้ว = "ไม่รู้" สถานะปัจจุบัน ห้ามเดาว่า 0% —
  // โควตานี้แชร์กับ Work / Workspace Agents / ChatGPT for Excel ฝั่งเว็บ
  // ซึ่งกินโควตาได้โดยไม่ทิ้งร่องรอยในเครื่องเลย (เคยเดาผิดมาแล้ว)
  if (Date.now() >= resetAt) return null;
  return { pct: Math.max(0, Math.min(999, w.used_percent)), resetAt };
}

/** คืน { session, weekly } หรือ null ถ้าไม่พบข้อมูล rate_limits เลย */
function fetchCodexLive(roots) {
  for (const f of newestJsonl(roots)) {
    let lines;
    try {
      lines = readTail(f.path).split('\n');
    } catch {
      continue;
    }
    // เริ่มที่ 1 เพราะบรรทัดแรกของ chunk มักโดนตัดครึ่ง
    for (let i = lines.length - 1; i >= 1; i--) {
      const s = lines[i].trim();
      if (!s || !s.includes('"rate_limits"')) continue;
      try {
        const obj = JSON.parse(s);
        const rl = obj?.payload?.rate_limits || obj?.rate_limits;
        if (!rl) continue;
        const ts = Date.parse(obj.timestamp) || f.mtime;
        const out = { session: null, weekly: null };
        for (const w of [rl.primary, rl.secondary]) {
          const m = mapCodexWindow(w, ts);
          if (!m) continue;
          // ≤10 ชม. ถือเป็นหน้าต่าง session, ยาวกว่านั้นคือรายสัปดาห์
          if ((w.window_minutes || 0) <= 600) out.session = m;
          else out.weekly = m;
        }
        if (out.session || out.weekly) return out;
      } catch { /* บรรทัดแตก ข้าม */ }
    }
  }
  return null;
}

module.exports = { fetchLive, fetchCodexLive };
