'use strict';
/**
 * usage.js — อ่านไฟล์ log ที่ CLI ของแต่ละเจ้าเขียนไว้ในเครื่อง แล้วคำนวณโควตา
 *
 * หลักการ: ไม่แตะไฟล์ credential / token / รหัสผ่านใด ๆ ทั้งสิ้น
 * อ่านเฉพาะไฟล์ .jsonl ที่บันทึกจำนวน token ของแต่ละ session เท่านั้น
 */
const fs = require('fs');
const path = require('path');

const BLOCK_MS = 5 * 60 * 60 * 1000; // บล็อก 5 ชั่วโมง
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

/** ค้นหา object ที่หน้าตาเหมือน usage ในระดับลึกไม่เกิน MAX_DEPTH */
function findUsage(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return null;
  const direct = readUsageShape(node);
  if (direct) return direct;
  // เรียงลำดับความสำคัญของ key ที่มักเก็บ usage ไว้
  const priority = ['usage', 'last_token_usage', 'total_token_usage', 'token_usage', 'message', 'info', 'response', 'payload'];
  for (const key of priority) {
    if (node[key]) {
      const found = findUsage(node[key], depth + 1);
      if (found) return found;
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (priority.includes(k)) continue;
    if (v && typeof v === 'object') {
      const found = findUsage(v, depth + 1);
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

/* ---------- เดินหาไฟล์ .jsonl ---------- */

function walkJsonl(root, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (e.isFile() && /\.jsonl$/i.test(e.name)) out.push(full);
  }
  return out;
}

/* ---------- แคชผลอ่านไฟล์ อ่านซ้ำเฉพาะไฟล์ที่เปลี่ยน ---------- */

const fileCache = new Map(); // path -> { mtimeMs, size, events }

function parseFile(file, provider) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.events;

  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const events = [];
  const seen = new Set();
  let best = null; // สำหรับโหมด cumulative-max

  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    const u = findUsage(obj);
    if (!u) continue;
    const ts = findTimestamp(obj, st.mtimeMs);
    const total = u.input + u.output + u.cacheCreate + u.cacheRead;
    if (total <= 0) continue;

    if (provider.aggregation === 'cumulative-max') {
      if (!best || total > best.total) best = { ...u, ts, total };
      continue;
    }
    const key = findDedupeKey(obj);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    events.push({ ts, ...u });
  }

  if (provider.aggregation === 'cumulative-max' && best) {
    events.push({ ts: best.ts, input: best.input, output: best.output, cacheCreate: best.cacheCreate, cacheRead: best.cacheRead });
  }

  events.sort((a, b) => a.ts - b.ts);
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, events });
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
  for (const r of roots) walkJsonl(r, files);
  const events = [];
  for (const f of files) events.push(...parseFile(f, provider));
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

/** ยอดถ่วงน้ำหนักรายชั่วโมง key = ms ต้นชั่วโมง — ใช้ป้อน history.json */
function buildHourly(events, w, now, hours = 48) {
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

  // ลิมิต: ค่าที่ผู้ใช้ปรับเทียบเองชนะทุกอย่าง > ค่าตามแพลน > P90 จากบล็อกที่ผ่านมา
  const cal = provider.calibration || {};
  const preset = presets[provider.plan] || presets.auto;
  const past = blocks.filter((b) => b !== active).map((b) => b.tokens);
  // ต้องมีบล็อกที่จบแล้วอย่างน้อย 3 บล็อก ค่า P90 จึงจะเชื่อถือได้
  const estimating = !cal.session && !preset.session && past.length < 3;
  const autoSession = estimating
    ? Math.max(50000, (active ? active.tokens : 0) * 2)
    : percentile(past, 90) || 50000;
  const sessionLimit = cal.session || preset.session || Math.round(autoSession);

  const weekFrom = opts.weeklyMode === 'calendar' ? startOfWeek(now) : now - 7 * 24 * 3600 * 1000;
  const weeklyTokens = events.filter((e) => e.ts >= weekFrom).reduce((s, e) => s + weighted(e, w), 0);
  const weeklyLimit = cal.weekly || preset.weekly || Math.max(Math.round(autoSession * 12), 1);

  const sessionTokens = active ? active.tokens : 0;
  const sessionPct = Math.min(999, (sessionTokens / sessionLimit) * 100);
  const weeklyPct = Math.min(999, (weeklyTokens / weeklyLimit) * 100);

  // อัตราการเผาผลาญ + เวลาที่คาดว่าจะเต็ม
  let burnPerHour = 0;
  let etaMs = null;
  if (active && active.count > 1) {
    const elapsedH = Math.max(0.05, (now - active.start) / 3600000);
    burnPerHour = active.tokens / elapsedH;
    const remain = sessionLimit - sessionTokens;
    if (burnPerHour > 0 && remain > 0) etaMs = (remain / burnPerHour) * 3600000;
  }

  return {
    ...base,
    ok: true,
    state: 'ok',
    estimating,
    calibrated: !!(cal.session || cal.weekly),
    session: {
      tokens: Math.round(sessionTokens),
      limit: sessionLimit,
      pct: sessionPct,
      resetAt: active ? active.end : null,
      startedAt: active ? active.start : null
    },
    weekly: {
      tokens: Math.round(weeklyTokens),
      limit: weeklyLimit,
      pct: weeklyPct,
      resetAt: opts.weeklyMode === 'calendar' ? startOfWeek(now) + 7 * 24 * 3600 * 1000 : null
    },
    burnPerHour: Math.round(burnPerHour),
    etaMs,
    spark: buildSpark(events, w, now),
    hourly: buildHourly(events, w, now),
    totalEvents: events.length,
    lastActivity: events[events.length - 1].ts
  };
}

function computeAll(config) {
  const presets = require('./config').PLAN_PRESETS;
  const out = [];
  for (const p of Object.values(config.providers)) {
    if (!p.enabled) continue;
    try {
      out.push(computeProvider(p, presets, { weeklyMode: config.weeklyMode }));
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

module.exports = { computeAll, computeProvider, exportCsv, BLOCK_MS };
