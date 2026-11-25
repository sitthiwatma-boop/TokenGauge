'use strict';
/**
 * usage.js — อ่านไฟล์ log ที่ CLI ของแต่ละเจ้าเขียนไว้ในเครื่อง แล้วคำนวณโควตา
 *
 * หลักการ: ไม่แตะไฟล์ credential / token / รหัสผ่านใด ๆ ทั้งสิ้น
 * อ่านเฉพาะไฟล์ .jsonl ที่บันทึกจำนวน token ของแต่ละ session เท่านั้น
 * (ยกเว้น Gemini CLI ที่เก็บเป็น session-*.json — จำกัดด้วยชื่อไฟล์ ดู filePattern)
 */
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const BLOCK_MS = 5 * 60 * 60 * 1000; // บล็อก 5 ชั่วโมง
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_LIMIT_TTL = 14 * 24 * 60 * 60 * 1000; // ลิมิตที่เรียนรู้เองมีอายุ 14 วัน
const MAX_DEPTH = 5;

/* ---------- ตัวช่วยดึงค่าออกจาก JSON ที่โครงสร้างต่างกันไปในแต่ละเจ้า ---------- */

const NUM = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

function readUsageShape(o) {
  if (!o || typeof o !== 'object') return null;
  const inp = o.input_tokens ?? o.prompt_tokens ?? o.input ?? o.inputTokens;
  const out = o.output_tokens ?? o.completion_tokens ?? o.output ?? o.outputTokens;
  if (typeof inp !== 'number' && typeof out !== 'number') return null;
  return {
    input: NUM(inp),
    output: NUM(out),
    cacheCreate: NUM(o.cache_creation_input_tokens ?? o.cached_creation_tokens ?? o.cacheCreationInputTokens),
    cacheRead: NUM(o.cache_read_input_tokens ?? o.cached_input_tokens ?? o.cacheReadInputTokens)
  };
}

/**
 * ลำดับ key ที่มักเก็บ usage ไว้ — ต้องเลือกให้ตรงกับ aggregation ของเจ้านั้น
 *
 * Codex เขียนทั้ง total_token_usage (ยอดสะสมของ session) และ last_token_usage
 * (ยอดเทิร์นล่าสุด) ไว้ใน payload.info ก้อนเดียวกัน โหมด 'cumulative-max' ต้องการ
 * ตัวสะสม ถ้าหยิบ last_ ไปจะกลายเป็น "เทิร์นที่ใหญ่สุดของไฟล์" ซึ่งต่ำกว่าจริงมาก
 * (วัดจาก log จริง 10 ไฟล์: 1.74M เทียบกับ 295M — ต่างกัน 170 เท่า)
 */
const PRIORITY_SUM = ['usage', 'last_token_usage', 'total_token_usage', 'token_usage', 'message', 'info', 'response', 'payload'];
const PRIORITY_CUMULATIVE = ['usage', 'total_token_usage', 'last_token_usage', 'token_usage', 'message', 'info', 'response', 'payload'];

/** ค้นหา object ที่หน้าตาเหมือน usage ในระดับลึกไม่เกิน MAX_DEPTH */
function findUsage(node, depth = 0, priority = PRIORITY_SUM) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return null;
  const direct = readUsageShape(node);
  if (direct) return direct;
  for (const key of priority) {
    if (node[key]) {
      const found = findUsage(node[key], depth + 1, priority);
      if (found) return found;
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (priority.includes(k)) continue;
    if (v && typeof v === 'object') {
      const found = findUsage(v, depth + 1, priority);
      if (found) return found;
    }
  }
  return null;
}

function findTimestamp(node, fallback) {
  const keys = ['timestamp', 'ts', 'created_at', 'createdAt', 'time', 'date'];
  for (const k of keys) {
    const v = node?.[k];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!isNaN(t)) return t;
    }
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  }
  for (const v of Object.values(node || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const t = findTimestamp(v, null);
      if (t) return t;
    }
  }
  return fallback;
}

function findDedupeKey(node) {
  const id = node?.message?.id ?? node?.id ?? node?.uuid;
  const req = node?.requestId ?? node?.request_id;
  if (id || req) return `${id || ''}:${req || ''}`;
  return null;
}

/* ---------- Gemini CLI ----------
 * ไฟล์ ~/.gemini/tmp/<hash>/chats/session-*.json — รุ่นเก่าเป็น JSON ก้อนเดียว
 * { sessionId, startTime, messages: [...] } และถูกเขียนทับทั้งไฟล์ทุกเทิร์น
 * รุ่นใหม่อาจเป็น JSONL (บรรทัดละ record) จึงลองแบบก้อนเดียวก่อนแล้วค่อยไล่ทีละบรรทัด
 *
 * ข้อความ type 'gemini' มี tokens = { input, output, cached, thoughts, tool, total }
 * กับดัก: `cached` เป็นส่วนหนึ่งของ `input` อยู่แล้ว (แบบเดียวกับ promptTokenCount ของ
 * Gemini API) ต้องหักออกก่อน ไม่งั้นแคชถูกนับสองรอบ และน้ำหนัก 0.1 ของแคชไม่มีผลเลย
 * ส่วน thoughts คิดราคาเท่า output จึงรวมเข้า output
 */
function geminiEvent(m, sessionId, fallbackTs) {
  const t = m?.tokens;
  if (!t || typeof t !== 'object') return null;
  if (m.type && m.type !== 'gemini') return null;
  const cached = NUM(t.cached);
  const ev = {
    ts: (typeof m.timestamp === 'string' && Date.parse(m.timestamp)) || fallbackTs,
    input: Math.max(0, NUM(t.input) - cached) + NUM(t.tool),
    output: NUM(t.output) + NUM(t.thoughts),
    cacheCreate: 0,
    cacheRead: cached
  };
  if (ev.input + ev.output + ev.cacheRead <= 0) return null;
  // key ข้ามไฟล์ — /compress เขียนไฟล์ใหม่ที่ใช้ sessionId เดิม ข้อความเดียวกันต้องไม่นับซ้ำ
  if (m.id) ev.dk = `${sessionId || ''}:${m.id}`;
  return ev;
}

/** แปลงข้อความทั้งไฟล์เป็น events (ฟังก์ชันล้วน เทสต์ได้) */
function parseGeminiText(text, fallbackTs = Date.now()) {
  let sessionId = null;
  const msgs = [];
  const take = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.sessionId === 'string') sessionId = o.sessionId;
    if (Array.isArray(o.messages)) msgs.push(...o.messages);
    const m = o.message && typeof o.message === 'object' ? o.message : o;
    if (m.tokens) msgs.push(m);
  };
  let whole = null;
  try {
    whole = JSON.parse(text);
  } catch { /* ไม่ใช่ JSON ก้อนเดียว — ลองแบบ JSONL */ }
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
    take(whole);
  } else {
    for (const line of String(text).split('\n')) {
      const s = line.trim();
      if (!s || s[0] !== '{') continue;
      try {
        take(JSON.parse(s));
      } catch { /* บรรทัดแตก (กำลังเขียนอยู่) ข้าม */ }
    }
  }
  // JSONL อาจเขียนข้อความเดิมซ้ำตอนอัปเดต — ยึดรุ่นล่าสุดของแต่ละ id
  const byId = new Map();
  const loose = [];
  for (const m of msgs) {
    const ev = geminiEvent(m, sessionId, fallbackTs);
    if (!ev) continue;
    if (ev.dk) byId.set(ev.dk, ev);
    else loose.push(ev);
  }
  return [...byId.values(), ...loose].sort((a, b) => a.ts - b.ts);
}

/* ---------- เดินหาไฟล์ log ---------- */

/** ชื่อไฟล์ที่อ่านได้ — Gemini เก็บเป็น .json จึงต้องจำกัดด้วยชื่อ ไม่งั้นจะไปหยิบไฟล์อื่นใน tmp */
function filePattern(provider) {
  return provider?.aggregation === 'gemini' ? /^session-.*\.jsonl?$/i : /\.jsonl$/i;
}

function walkJsonl(root, out = [], depth = 0, re = /\.jsonl$/i) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkJsonl(full, out, depth + 1, re);
    else if (e.isFile() && re.test(e.name)) out.push(full);
  }
  return out;
}

/* ---------- แคชผลอ่านไฟล์ อ่านซ้ำเฉพาะไฟล์ที่เปลี่ยน ---------- */

/**
 * key = `${aggregation}|${path}` → สถานะการอ่านไฟล์นั้น
 * { mtimeMs, size, offset, carry, skipping, seen, best, events, gemini? }
 *
 * ห้ามกลับไปใช้ readFileSync ทั้งไฟล์ — log ของ Codex ไฟล์เดียวโตได้ถึง 1.7 GB
 * (เจอจริง 25 พ.ย. 2026) อ่านทั้งก้อนแล้วหน่วยความจำของ Electron เต็ม แอปตายแบบ native
 * ภายในไม่กี่วินาทีหลังเปิด โดยไม่มี error ให้เห็นเลย (exit -36861) จึงอ่านทีละท่อน
 * และไฟล์ .jsonl เขียนต่อท้ายอย่างเดียว พอไฟล์โตขึ้นก็อ่านต่อจาก offset เดิม
 * ไฟล์ใหญ่จึงเสียเวลาอ่านเต็มแค่ครั้งแรกครั้งเดียว
 */
const fileCache = new Map();

const CHUNK = 4 * 1024 * 1024;
// บรรทัดที่ยาวเกินนี้คือผลลัพธ์ของเครื่องมือ (ไฟล์ทั้งไฟล์, ภาพ base64) ไม่ใช่บรรทัด usage
// ทิ้งไปเลย ไม่งั้นสตริงก้อนเดียวอาจใหญ่หลายร้อย MB
const MAX_LINE = 16 * 1024 * 1024;
// Gemini เก็บทั้ง session เป็น JSON ก้อนเดียว — ใหญ่เกินนี้ถือว่าผิดปกติ ไล่ทีละบรรทัดแทน
const GEMINI_WHOLE_MAX = 64 * 1024 * 1024;

/** อ่านไฟล์ตั้งแต่ตำแหน่ง from ทีละท่อน ส่งบรรทัดที่ครบแล้วให้ onLine คืน { offset, carry, skipping } */
function readLines(file, from, carry, skipping, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = from;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const text = decoder.write(buf.subarray(0, n));
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl < 0) break;
        if (!skipping && carry.length + (nl - start) <= MAX_LINE) onLine(carry + text.slice(start, nl));
        carry = '';
        skipping = false;
        start = nl + 1;
      }
      if (!skipping) {
        carry += text.slice(start);
        if (carry.length > MAX_LINE) {
          carry = '';
          skipping = true;
        }
      }
    }
    return { offset: pos, carry, skipping };
  } finally {
    fs.closeSync(fd);
  }
}

function parseFile(file, provider) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const cumulative = provider.aggregation === 'cumulative-max';
  // aggregation เป็นส่วนหนึ่งของ key เพราะมันเปลี่ยน key ที่เลือกอ่าน (ดู PRIORITY_*)
  const key = `${provider.aggregation}|${file}`;
  const cached = fileCache.get(key);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.events;

  if (provider.aggregation === 'gemini') {
    // ไฟล์ของ Gemini ถูกเขียนทับทั้งไฟล์ทุกเทิร์น อ่านต่อจาก offset ไม่ได้ ต้องอ่านใหม่ทั้งไฟล์
    let text = '';
    try {
      if (st.size <= GEMINI_WHOLE_MAX) {
        text = fs.readFileSync(file, 'utf8');
      } else {
        const lines = [];
        readLines(file, 0, '', false, (l) => {
          if (l.includes('"tokens"')) lines.push(l);
        });
        text = lines.join('\n');
      }
    } catch {
      return [];
    }
    const events = parseGeminiText(text, st.mtimeMs);
    fileCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, events });
    return events;
  }

  // ไฟล์โตขึ้นจากเดิม = มีบรรทัดใหม่ต่อท้าย → อ่านต่อจากเดิม, เล็กลง = ถูกเขียนใหม่ → เริ่มใหม่
  const resume = cached && cached.offset != null && st.size > cached.offset;
  const state = resume
    ? cached
    : { offset: 0, carry: '', skipping: false, seen: new Set(), best: null, sumEvents: [] };

  const onLine = (line) => {
    // คัดก่อน parse — บรรทัดส่วนใหญ่ของ log คือข้อความ/ผลของเครื่องมือ ไม่มี usage
    // ทุกรูปแบบที่ readUsageShape อ่านได้มีคำว่า token อยู่ในชื่อ key ทั้งนั้น
    if (line.indexOf('oken') < 0) return;
    const s = line.trim();
    if (!s || s[0] !== '{') return;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      return;
    }
    const u = findUsage(obj, 0, cumulative ? PRIORITY_CUMULATIVE : PRIORITY_SUM);
    if (!u) return;
    const ts = findTimestamp(obj, st.mtimeMs);
    const total = u.input + u.output + u.cacheCreate + u.cacheRead;
    if (total <= 0) return;

    if (cumulative) {
      if (!state.best || total > state.best.total) state.best = { ...u, ts, total };
      return;
    }
    const dk = findDedupeKey(obj);
    if (dk) {
      if (state.seen.has(dk)) return;
      state.seen.add(dk);
    }
    state.sumEvents.push({ ts, ...u });
  };

  try {
    const r = readLines(file, state.offset, state.carry, state.skipping, onLine);
    state.offset = r.offset;
    state.carry = r.carry;
    state.skipping = r.skipping;
  } catch {
    return cached ? cached.events : [];
  }

  let events;
  if (cumulative) {
    const b = state.best;
    events = b ? [{ ts: b.ts, input: b.input, output: b.output, cacheCreate: b.cacheCreate, cacheRead: b.cacheRead }] : [];
  } else {
    // บรรทัดสุดท้ายที่ไม่มี \n ปิด (กำลังเขียนอยู่) ยังอยู่ใน carry — ลองแกะดูโดยไม่เก็บเข้าสถานะ
    // ถ้าแกะได้ รอบหน้าบรรทัดนี้จะถูกอ่านซ้ำแต่ dedupe ด้วย message id อยู่แล้ว
    state.sumEvents.sort((a, b) => a.ts - b.ts);
    events = state.sumEvents;
  }
  if (state.carry && !state.skipping) {
    const before = cumulative ? state.best : state.sumEvents.length;
    const savedSeen = cumulative ? null : new Set(state.seen);
    onLine(state.carry);
    if (cumulative) {
      const b = state.best;
      if (b && b !== before) events = [{ ts: b.ts, input: b.input, output: b.output, cacheCreate: b.cacheCreate, cacheRead: b.cacheRead }];
      state.best = before; // ไม่ commit บรรทัดที่ยังเขียนไม่จบ
    } else if (state.sumEvents.length > before) {
      events = [...state.sumEvents].sort((a, b) => a.ts - b.ts);
      state.sumEvents.length = before;
      state.seen = savedSeen;
    }
  }

  fileCache.set(key, { ...state, mtimeMs: st.mtimeMs, size: st.size, events });
  return events;
}

function collectEvents(provider) {
  const roots = (provider.roots || []).filter((r) => {
    try {
      return fs.existsSync(r);
    } catch {
      return false;
    }
  });
  if (!roots.length) return { events: [], roots: [], missing: true };

  const files = [];
  const re = filePattern(provider);
  for (const r of roots) walkJsonl(r, files, 0, re);
  const events = [];
  const seen = new Set(); // dk = key ข้ามไฟล์ (ตอนนี้มีแต่ Gemini)
  for (const f of files) {
    for (const e of parseFile(f, provider)) {
      if (e.dk) {
        if (seen.has(e.dk)) continue;
        seen.add(e.dk);
      }
      events.push(e);
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, roots, files: files.length, missing: false };
}

/* ---------- คำนวณ ---------- */

function weighted(e, w) {
  return e.input + e.output + e.cacheCreate + e.cacheRead * w;
}

/** จัดกลุ่มเป็นบล็อก 5 ชั่วโมง โดยเริ่มบล็อกที่ต้นชั่วโมงของข้อความแรก */
function buildBlocks(events, w) {
  const blocks = [];
  let cur = null;
  for (const e of events) {
    const val = weighted(e, w);
    if (!cur || e.ts >= cur.end || e.ts - cur.lastTs > BLOCK_MS) {
      const start = new Date(e.ts);
      start.setMinutes(0, 0, 0);
      cur = { start: start.getTime(), end: start.getTime() + BLOCK_MS, tokens: 0, count: 0, lastTs: e.ts };
      blocks.push(cur);
    }
    cur.tokens += val;
    cur.count += 1;
    cur.lastTs = e.ts;
  }
  return blocks;
}

/** ยอดถ่วงน้ำหนัก + จำนวน event + เวลาของ event แรก ในช่วง [from, to) — to = null คือไม่จำกัด */
function sumRange(events, w, from, to) {
  let tokens = 0;
  let count = 0;
  let firstTs = null;
  for (const e of events) {
    if (e.ts < from || (to != null && e.ts >= to)) continue;
    tokens += weighted(e, w);
    count += 1;
    if (firstTs == null || e.ts < firstTs) firstTs = e.ts;
  }
  return { tokens, count, firstTs };
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

function startOfWeek(now) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // จันทร์ = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** สร้าง sparkline 24 ชั่วโมงย้อนหลัง (24 ช่อง ช่องละ 1 ชม.) */
function buildSpark(events, w, now) {
  const bins = new Array(24).fill(0);
  const from = now - 24 * 3600 * 1000;
  for (const e of events) {
    if (e.ts < from) continue;
    const idx = Math.min(23, Math.floor((e.ts - from) / 3600000));
    bins[idx] += weighted(e, w);
  }
  return bins.map((v) => Math.round(v));
}

/** ยอดถ่วงน้ำหนักรายชั่วโมง key = ms ต้นชั่วโมง — ใช้ป้อน history.json
 * ครอบ 90 วันเต็ม เพื่อ backfill ประวัติจาก log ที่ยังอยู่ ตั้งแต่รันครั้งแรก */
function buildHourly(events, w, now, hours = 90 * 24) {
  const map = {};
  const from = now - hours * 3600 * 1000;
  for (const e of events) {
    if (e.ts < from) continue;
    const h = Math.floor(e.ts / 3600000) * 3600000;
    map[h] = (map[h] || 0) + weighted(e, w);
  }
  for (const k of Object.keys(map)) map[k] = Math.round(map[k]);
  return map;
}

function computeProvider(provider, presets, opts = {}) {
  const now = opts.now || Date.now();
  const w = provider.cacheReadWeight ?? 0.1;
  const { events, missing, files } = collectEvents(provider);

  const base = {
    id: provider.id,
    name: provider.name,
    subtitle: provider.subtitle,
    accent: provider.accent,
    plan: provider.plan,
    planLabel: (presets[provider.plan] || {}).label || provider.plan,
    ok: false,
    files: files || 0
  };

  if (missing) return { ...base, state: 'unconfigured', message: 'ยังไม่พบโฟลเดอร์ log — ตั้ง path ได้ในหน้าตั้งค่า' };
  if (!events.length) return { ...base, state: 'empty', message: 'พบโฟลเดอร์แล้ว แต่ยังไม่มีข้อมูลการใช้งาน' };

  const blocks = buildBlocks(events, w);
  const active = blocks.find((b) => now >= b.start && now < b.end) || null;

  // ขอบหน้าต่างที่ผู้ให้บริการบอกมาเอง (มาคู่กับ % ทางการ ดู applyLive ใน main.js)
  // ถ้ามี ให้นับ token ในกรอบเดียวกับเขา ไม่งั้นตัวเลขที่นับได้จะคนละหน้าต่างกับ % ที่โชว์
  // (เคยทำให้รายสัปดาห์ขึ้นแดง 97% ทั้งที่ทางการบอก 3% เพราะรอบเพิ่งรีเซ็ตไปเมื่อเช้า)
  // ความยาวหน้าต่างเอาตามที่ผู้ให้บริการบอก (Codex บอกเป็น window_minutes) ไม่งั้นใช้ค่ามาตรฐาน
  const hint = opts.window || {};
  const sessionFrom = hint.session > 0 ? hint.session - (hint.sessionMs > 0 ? hint.sessionMs : BLOCK_MS) : null;
  const weeklyReset = hint.weekly > 0 ? hint.weekly : null;
  const weeklyMs = hint.weeklyMs > 0 ? hint.weeklyMs : WEEK_MS;

  // ลิมิต: ค่าที่ผู้ใช้ปรับเทียบเองชนะทุกอย่าง > ค่าที่เรียนรู้จาก % ทางการ > ค่าตามแพลน > P90
  const cal = provider.calibration || {};
  // ค่าที่เรียนรู้ต้องหมดอายุ ไม่งั้นค่าที่เพี้ยนตอน API ล่มจะค้างถาวรข้ามการรีสตาร์ต
  // และผู้ใช้จะเปลี่ยนแพลนในหน้าตั้งค่าแล้วไม่มีอะไรเกิดขึ้นตลอดไป
  const ll = provider.liveLimit;
  const learned = ll?.at > 0 && now - ll.at < LIVE_LIMIT_TTL ? ll : {};
  const preset = presets[provider.plan] || presets.auto;
  const past = blocks.filter((b) => b !== active).map((b) => b.tokens);
  // ต้องมีบล็อกที่จบแล้วอย่างน้อย 3 บล็อก ค่า P90 จึงจะเชื่อถือได้
  const estimating = !cal.session && !learned.session && !preset.session && past.length < 3;
  const autoSession = estimating
    ? Math.max(50000, (active ? active.tokens : 0) * 2)
    : percentile(past, 90) || 50000;
  const sessionLimit = cal.session || learned.session || preset.session || Math.round(autoSession);

  const weekFrom = weeklyReset != null
    ? weeklyReset - weeklyMs
    : opts.weeklyMode === 'calendar' ? startOfWeek(now) : now - WEEK_MS;
  // ต้องมีขอบบนด้วยเมื่อรอบมาจากผู้ให้บริการ ไม่งั้นการใช้งานหลังรอบรีเซ็ตจะถูกนับ
  // เข้ารอบเก่า แล้วลิมิตที่ถอดกลับจะพองตาม (session ใช้ [from, to) อยู่แล้ว ต้องสมมาตรกัน)
  const weeklyTokens = sumRange(events, w, weekFrom, weeklyReset).tokens;
  const weeklyLimit = cal.weekly || learned.weekly || preset.weekly || Math.max(Math.round(autoSession * 12), 1);

  const sess = sessionFrom != null
    ? sumRange(events, w, sessionFrom, hint.session)
    : { tokens: active ? active.tokens : 0, count: active ? active.count : 0 };
  const sessionStart = sessionFrom != null ? sessionFrom : active ? active.start : null;
  const sessionTokens = sess.tokens;
  const sessionPct = Math.min(999, (sessionTokens / sessionLimit) * 100);
  const weeklyPct = Math.min(999, (weeklyTokens / weeklyLimit) * 100);

  // อัตราการเผาผลาญ + เวลาที่คาดว่าจะเต็ม
  // นับเวลาที่ผ่านไปจาก "การใช้งานครั้งแรกในรอบ" ไม่ใช่ขอบซ้ายของหน้าต่าง —
  // ถ้าผู้ใช้เพิ่งเริ่มใช้ตอนท้ายรอบ การหารด้วยเวลาว่างตอนต้นจะทำให้อัตราต่ำผิดไปหลายเท่า
  // แล้ว ETA จะบอกว่า "อีก 4.7 ชม.จะเต็ม" ทั้งที่รอบจะรีเซ็ตใน 20 นาที
  let burnPerHour = 0;
  let etaMs = null;
  const burnFrom = sess.firstTs != null ? Math.max(sessionStart, sess.firstTs) : sessionStart;
  if (burnFrom != null && sess.count > 1) {
    const elapsedH = Math.max(0.05, (now - burnFrom) / 3600000);
    burnPerHour = sessionTokens / elapsedH;
    const remain = sessionLimit - sessionTokens;
    if (burnPerHour > 0 && remain > 0) etaMs = (remain / burnPerHour) * 3600000;
  }

  return {
    ...base,
    ok: true,
    state: 'ok',
    estimating,
    calibrated: !!(cal.session || cal.weekly),
    // 'live' = นับในหน้าต่างเดียวกับผู้ให้บริการ จึงคำนวณลิมิตย้อนกลับจากตัวเลขนี้ได้
    windowSource: {
      session: sessionFrom != null ? 'live' : 'block',
      weekly: weeklyReset != null ? 'live' : opts.weeklyMode === 'calendar' ? 'calendar' : 'rolling'
    },
    session: {
      tokens: Math.round(sessionTokens),
      limit: sessionLimit,
      pct: sessionPct,
      resetAt: sessionFrom != null ? hint.session : active ? active.end : null,
      startedAt: sessionStart
    },
    weekly: {
      tokens: Math.round(weeklyTokens),
      limit: weeklyLimit,
      pct: weeklyPct,
      resetAt: weeklyReset != null
        ? weeklyReset
        : opts.weeklyMode === 'calendar' ? startOfWeek(now) + WEEK_MS : null
    },
    burnPerHour: Math.round(burnPerHour),
    etaMs,
    spark: buildSpark(events, w, now),
    hourly: buildHourly(events, w, now),
    totalEvents: events.length,
    lastActivity: events[events.length - 1].ts
  };
}

/** opts.liveWindows = { <id>: { session, weekly } } เวลารีเซ็ตจริงจากผู้ให้บริการ (ถ้ามี) */
function computeAll(config, opts = {}) {
  const presets = require('./config').PLAN_PRESETS;
  const out = [];
  for (const p of Object.values(config.providers)) {
    if (!p.enabled) continue;
    try {
      out.push(computeProvider(p, presets, {
        weeklyMode: config.weeklyMode,
        window: opts.liveWindows?.[p.id] || null
      }));
    } catch (err) {
      out.push({ id: p.id, name: p.name, accent: p.accent, state: 'error', message: String(err.message || err) });
    }
  }
  return { updatedAt: Date.now(), providers: out };
}

function exportCsv(config) {
  const rows = [['provider', 'timestamp', 'input', 'output', 'cache_create', 'cache_read']];
  for (const p of Object.values(config.providers)) {
    if (!p.enabled) continue;
    const { events } = collectEvents(p);
    for (const e of events) {
      rows.push([p.id, new Date(e.ts).toISOString(), e.input, e.output, e.cacheCreate, e.cacheRead]);
    }
  }
  return rows.map((r) => r.join(',')).join('\n');
}

module.exports = { computeAll, computeProvider, exportCsv, parseGeminiText, BLOCK_MS, WEEK_MS };
