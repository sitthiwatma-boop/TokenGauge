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
    // truncated = อ่านมาไม่ครบไฟล์ → บรรทัดแรกของ chunk อาจโดนตัดครึ่ง
    return { text: buf.toString('utf8'), truncated: size > len };
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
    let tail;
    try {
      tail = readTail(f.path);
    } catch {
      continue;
    }
    const lines = tail.text.split('\n');
    // ข้ามบรรทัดแรกเฉพาะตอนอ่านไม่ครบไฟล์ (มันอาจโดนตัดครึ่ง) — ไฟล์เล็กต้องอ่านครบทุกบรรทัด
    const first = tail.truncated ? 1 : 0;
    for (let i = lines.length - 1; i >= first; i--) {
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

/* ---------- ChatGPT ผ่าน API โดยตรง (opt-in, ทดลอง) ----------
 * ใช้ token ของ Codex CLI ถาม backend ของ ChatGPT แบบเดียวกับฝั่ง Claude
 * endpoint ไม่มีเอกสารทางการ จึงลองหลายตัวตามลำดับ — ถ้าใช้ไม่ได้
 * แอปจะถอยไปอ่านจาก log / ค่าปักหมุดเองโดยอัตโนมัติ ไม่มีอะไรพัง
 * เงื่อนไขเดิม: ไม่ log ไม่เก็บ token และส่งหา chatgpt.com ที่เดียวเท่านั้น
 */
const CODEX_API_PATHS = ['/backend-api/codex/usage', '/backend-api/wham/usage'];

let codexApi = { at: 0, data: null, error: null };
let codexApiLastGood = { at: 0, data: null };
let codexApiBackoffUntil = 0;

function readCodexToken() {
  const p = path.join(os.homedir(), '.codex', 'auth.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    throw new Error('ไม่พบไฟล์ auth ของ Codex — ล็อกอิน Codex CLI ก่อน');
  }
  const j = JSON.parse(raw);
  const tok = j?.tokens?.access_token;
  if (!tok) throw new Error('ไม่พบ access token ของ Codex');
  return { tok, acc: j?.tokens?.account_id || '' };
}

function codexRequest(reqPath, auth) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'chatgpt.com',
        path: reqPath,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${auth.tok}`,
          'chatgpt-account-id': auth.acc,
          'Content-Type': 'application/json',
          'User-Agent': 'codex-cli'
        },
        timeout: 10000
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ status: res.statusCode });
          try {
            resolve({ status: 200, json: JSON.parse(body) });
          } catch {
            resolve({ status: 200, json: null });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('หมดเวลาเชื่อมต่อ')));
    req.on('error', () => reject(new Error('ต่ออินเทอร์เน็ตไม่ได้')));
    req.end();
  });
}

/** แปลงคำตอบ (โครงไม่แน่นอน) เป็น { session, weekly } — คืน null ถ้าอ่านไม่ออก */
function parseCodexApi(json) {
  if (!json) return null;
  const rl = json.rate_limits || json.rateLimits || json;
  const out = { session: null, weekly: null };
  // แบบเดียวกับใน log: primary/secondary + window_minutes
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.used_percent !== 'number') continue;
    const resetAt = w.resets_at ? w.resets_at * 1000 : null;
    const v = { pct: Math.max(0, Math.min(999, w.used_percent)), resetAt };
    if ((w.window_minutes || 0) <= 600) out.session = v;
    else out.weekly = v;
  }
  // เผื่อโครงแบบเดียวกับของ Anthropic
  if (!out.session && !out.weekly) {
    out.session = normalize(windowOf(rl, ['five_hour', 'session']));
    out.weekly = normalize(windowOf(rl, ['seven_day', 'weekly']));
  }
  return out.session || out.weekly ? out : null;
}

async function fetchCodexApiLive() {
  const now = Date.now();
  if (now - codexApi.at < CACHE_MS) {
    if (codexApi.error) throw new Error(codexApi.error);
    if (codexApi.data) return codexApi.data;
  }
  if (now < codexApiBackoffUntil) {
    if (codexApiLastGood.data && now - codexApiLastGood.at < STALE_MS) return codexApiLastGood.data;
    throw new Error(codexApi.error || 'พัก API ชั่วคราว');
  }
  try {
    const auth = readCodexToken();
    let lastStatus = 0;
    for (const p of CODEX_API_PATHS) {
      const r = await codexRequest(p, auth);
      lastStatus = r.status;
      if (r.status === 200) {
        const data = parseCodexApi(r.json);
        if (!data) continue;
        codexApi = { at: now, data, error: null };
        codexApiLastGood = { at: now, data };
        return data;
      }
      if (r.status === 401 || r.status === 403) {
        throw new Error('token ของ Codex หมดอายุ — ใช้งาน Codex สักครั้งเพื่อต่ออายุ');
      }
      if (r.status === 429) {
        codexApiBackoffUntil = now + BACKOFF_MS;
        throw new Error('ถูกจำกัดคำขอชั่วคราว');
      }
    }
    // ไม่มี endpoint ไหนใช้ได้ (404/รูปแบบไม่รู้จัก) — พักยาวหน่อย ไม่ยิงถี่
    codexApiBackoffUntil = now + BACKOFF_MS;
    throw new Error(`OpenAI ยังไม่เปิด endpoint ให้ถาม (${lastStatus}) — ใช้ข้อมูลจาก log แทน`);
  } catch (err) {
    const msg = String(err.message || err);
    if (codexApiLastGood.data && now - codexApiLastGood.at < STALE_MS) {
      codexApi = { at: now, data: codexApiLastGood.data, error: null };
      return codexApiLastGood.data;
    }
    codexApi = { at: now, data: null, error: msg };
    throw err;
  }
}

/* ---------- Grok (grok.com) — ตัวแปลงคำตอบ /rest/rate-limits ----------
 * ส่วนยิงเน็ตอยู่ใน src/grokweb.js (ต้องใช้ Electron session) — แยกตัวแปลงมาไว้ที่นี่
 * เป็นฟังก์ชันล้วนเพื่อเทสต์ได้ด้วย node เปล่า ๆ
 * โครงคำตอบไม่ทางการและเปลี่ยนได้ จึงเดินหา object ที่มีคู่ remaining/total แบบยืดหยุ่น
 * (แนวเดียวกับ findUsage ใน usage.js)
 */
/** หาเวลารีเซ็ตจาก key ที่หน้าตาเหมือน reset/renew/expire — รับได้ทั้ง ISO, epoch วินาที/ms, วินาทีนับจากนี้ */
function grokResetAt(o, now) {
  for (const [k, v] of Object.entries(o)) {
    if (!/reset|renew|expire/i.test(k)) continue;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (isFinite(t) && t > now) return t;
      continue;
    }
    const n = Number(v);
    if (!isFinite(n) || n <= 0) continue;
    if (n > 1e12) return n; // epoch ms
    if (n > 1e9) return n * 1000; // epoch วินาที
    return now + n * 1000; // วินาทีนับจากนี้
  }
  const waitSec = Number(o.waitTimeSeconds ?? o.wait_time_seconds) || 0;
  return waitSec > 0 ? now + waitSec * 1000 : null;
}

function grokWindow(o, now) {
  const winSec =
    Number(o.windowSizeSeconds ?? o.window_size_seconds) ||
    (Number(o.window_minutes ?? o.windowMinutes) || 0) * 60;
  // แบบที่ 1: คู่ remaining/total หรือ used/limit — คำนวณ % เอง
  const total = Number(o.totalQueries ?? o.total_queries ?? o.totalTokens ?? o.total ?? o.limit ?? o.max);
  const remaining = Number(o.remainingQueries ?? o.remaining_queries ?? o.remainingTokens ?? o.remaining);
  const used = Number(o.usedQueries ?? o.used_queries ?? o.usedTokens ?? o.used);
  if (isFinite(total) && total > 0) {
    const pct = isFinite(remaining) ? (1 - remaining / total) * 100 : isFinite(used) ? (used / total) * 100 : null;
    if (pct != null) {
      return {
        pct: Math.max(0, Math.min(999, pct)),
        resetAt: grokResetAt(o, now),
        winSec
      };
    }
  }
  // แบบที่ 2: บอกเปอร์เซ็นต์ตรง ๆ (แบบหน้า Usage — "63% used" หรือ "0% remaining")
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'object' || !/percent|pct/i.test(k)) continue;
    const raw = Number(v);
    if (isFinite(raw) && raw >= 0 && raw <= 100) {
      // คีย์แบบ "remaining/left" คือ % ที่เหลือ ต้องกลับด้านเป็น % ที่ใช้ไป
      const pct = /remaining|left/i.test(k) ? 100 - raw : raw;
      return { pct, resetAt: grokResetAt(o, now), winSec };
    }
  }
  return null;
}

/** คืน { session, weekly } หรือ null ถ้าไม่พบหน้าต่างโควตาที่อ่านออกเลย */
function parseGrokRateLimits(json, now = Date.now()) {
  if (!json || typeof json !== 'object') return null;
  const wins = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    const w = grokWindow(o, now);
    if (w) return void wins.push(w);
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(json, 0);
  if (!wins.length) return null;
  // ≤10 ชม. = รอบสั้น (session), ยาวกว่าหรือไม่บอกขนาด = รายสัปดาห์ (ช่องเดียวกับปักหมุด)
  // มีหลายหน้าต่างในกลุ่มเดียวกัน เอาอันที่ใช้ไปมากสุด — ตัวที่บีบเราจริง
  const out = { session: null, weekly: null };
  for (const w of wins) {
    const key = w.winSec > 0 && w.winSec <= 36000 ? 'session' : 'weekly';
    if (!out[key] || w.pct > out[key].pct) out[key] = { pct: w.pct, resetAt: w.resetAt };
  }
  return out;
}

/** อ่านคำตอบที่อาจไม่ใช่ JSON ตรง ๆ — หน้า Usage ของ grok.com ส่งข้อมูลแบบ
 *  React Server Components (ข้อความยาวที่มี JSON ฝังเป็นท่อน ๆ บางทีถูก escape)
 *  จึงดึง object แบน ๆ ที่มีคีย์เปอร์เซ็นต์/remaining ออกมาลองแปลงทีละตัว */
function parseGrokText(text, now = Date.now()) {
  if (!text) return null;
  try {
    return parseGrokRateLimits(JSON.parse(text), now);
  } catch { /* ไม่ใช่ JSON เดี่ยว — ขุดจากข้อความต่อ */ }
  const out = { session: null, weekly: null };
  let found = false;
  const chunk = text.slice(0, 3 * 1024 * 1024);
  for (const m of chunk.match(/\{[^{}]*(?:percent|pct|remaining|used|quota)[^{}]*\}/gi) || []) {
    let obj = null;
    try {
      obj = JSON.parse(m);
    } catch {
      try {
        obj = JSON.parse(m.replace(/\\"/g, '"')); // JSON ที่ถูก escape อยู่ในสตริงอีกชั้น
      } catch {
        continue;
      }
    }
    const d = parseGrokRateLimits(obj, now);
    if (!d) continue;
    found = true;
    for (const k of ['session', 'weekly']) {
      if (d[k] && (!out[k] || d[k].pct > out[k].pct)) out[k] = d[k];
    }
  }
  return found ? out : null;
}

module.exports = { fetchLive, fetchCodexLive, fetchCodexApiLive, parseGrokRateLimits, parseGrokText };
