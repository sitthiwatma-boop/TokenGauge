'use strict';
/**
 * ชุดเทสต์ตรรกะหลักของ TokenGauge — รันด้วย `npm test` (node ล้วน ไม่มี framework)
 * ครอบคลุมจุดที่เคยเข้าใจผิด/พังมาแล้ว: aggregation สองแบบ, บล็อก 5 ชม.,
 * calibration, การ map หน้าต่างโควตาของ Codex และการเก็บประวัติ
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const usage = require('../src/usage');
const liveusage = require('../src/liveusage');
const { fetchCodexLive, parseWebRateLimits, parseWebText, usableSnapshot } = liveusage;
const history = require('../src/history');
const { PLAN_PRESETS } = require('../src/config');

const TMP = path.join(os.tmpdir(), 'tokengauge-test-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0, seq = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ' — ' + e.message);
  }
}
function eq(got, want, msg) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg || 'ค่าไม่ตรง'}: ได้ ${JSON.stringify(got)} คาด ${JSON.stringify(want)}`);
  }
}
function ok(v, msg) {
  if (!v) throw new Error(msg || 'คาดค่าจริง');
}

/** สร้างโฟลเดอร์ fixture ใหม่ พร้อมไฟล์ .jsonl — โฟลเดอร์แยกกันทุกครั้งกัน fileCache ปนกัน */
function fixture(files) {
  const dir = path.join(TMP, 'fx' + seq++);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  }
  return dir;
}

const NOW = Date.parse('2026-08-05T12:30:00Z');
const iso = (ms) => new Date(ms).toISOString();
const H = 3600 * 1000;

function claudeLine(ts, u, id) {
  return { timestamp: iso(ts), message: { id: id || 'id' + Math.random(), usage: u } };
}
function prov(dir, over = {}) {
  return {
    id: 'test', name: 'Test', roots: [dir],
    aggregation: 'sum', cacheReadWeight: 0.1, plan: 'max5',
    ...over
  };
}
const run = (p, now = NOW) => usage.computeProvider(p, PLAN_PRESETS, { weeklyMode: 'rolling', now });
/** เหมือน run แต่ป้อนเวลารีเซ็ตจริงจากผู้ให้บริการเข้าไปด้วย */
const runW = (p, window, now = NOW) =>
  usage.computeProvider(p, PLAN_PRESETS, { weeklyMode: 'rolling', now, window });

console.log('\nusage.js');

t('aggregation sum: บวกสะสมทุกบรรทัด', () => {
  const dir = fixture({ 'a.jsonl': [
    claudeLine(NOW - 10 * 60000, { input_tokens: 100, output_tokens: 50 }),
    claudeLine(NOW - 5 * 60000, { input_tokens: 100, output_tokens: 50 })
  ] });
  eq(run(prov(dir)).session.tokens, 300);
});

t('cache read ถ่วงน้ำหนัก 0.1 / cache create เต็มราคา', () => {
  const dir = fixture({ 'a.jsonl': [
    claudeLine(NOW - 10 * 60000, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000 })
  ] });
  eq(run(prov(dir)).session.tokens, 300); // 200 + 1000*0.1
});

t('dedupe: message.id ซ้ำนับครั้งเดียว', () => {
  const dir = fixture({ 'a.jsonl': [
    claudeLine(NOW - 10 * 60000, { input_tokens: 100, output_tokens: 0 }, 'same'),
    claudeLine(NOW - 9 * 60000, { input_tokens: 100, output_tokens: 0 }, 'same')
  ] });
  eq(run(prov(dir)).session.tokens, 100);
});

t('cumulative-max: เอาค่าสูงสุดต่อไฟล์ ไม่ใช่บวกสะสม', () => {
  const dir = fixture({ 'a.jsonl': [
    { timestamp: iso(NOW - 20 * 60000), total_token_usage: { input_tokens: 80, output_tokens: 20 } },
    { timestamp: iso(NOW - 10 * 60000), total_token_usage: { input_tokens: 300, output_tokens: 100 } }
  ] });
  eq(run(prov(dir, { aggregation: 'cumulative-max' })).session.tokens, 400);
});

t('cumulative-max: คนละไฟล์บวกกันได้', () => {
  const dir = fixture({
    'a.jsonl': [{ timestamp: iso(NOW - 20 * 60000), total_token_usage: { input_tokens: 400, output_tokens: 0 } }],
    'b.jsonl': [{ timestamp: iso(NOW - 10 * 60000), total_token_usage: { input_tokens: 300, output_tokens: 0 } }]
  });
  eq(run(prov(dir, { aggregation: 'cumulative-max' })).session.tokens, 700);
});

t('findUsage: เจอ usage ซ่อนลึกหลายชั้น', () => {
  const dir = fixture({ 'a.jsonl': [
    { timestamp: iso(NOW - 10 * 60000), a: { b: { usage: { prompt_tokens: 150, completion_tokens: 50 } } } }
  ] });
  eq(run(prov(dir)).session.tokens, 200);
});

t('บล็อก 5 ชม.: เว้นเกินบล็อกเดิม = ขึ้นบล็อกใหม่ และไม่มี active ตอนนี้', () => {
  const d0 = Date.parse('2026-08-05T01:10:00Z');
  const d1 = Date.parse('2026-08-05T07:30:00Z'); // เกิน 06:00 (จุดจบบล็อกแรก)
  const dir = fixture({ 'a.jsonl': [
    claudeLine(d0, { input_tokens: 100, output_tokens: 0 }),
    claudeLine(d1, { input_tokens: 100, output_tokens: 0 })
  ] });
  const r = run(prov(dir), Date.parse('2026-08-05T13:00:00Z'));
  eq(r.session.tokens, 0, 'ไม่มีบล็อก active');
  eq(r.session.resetAt, null);
});

t('บล็อกเริ่มที่ต้นชั่วโมงของข้อความแรก', () => {
  const d0 = Date.parse('2026-08-05T12:34:00Z');
  const dir = fixture({ 'a.jsonl': [claudeLine(d0, { input_tokens: 10, output_tokens: 0 })] });
  const r = run(prov(dir), d0 + 60000);
  eq(r.session.startedAt, Date.parse('2026-08-05T12:00:00Z'));
  eq(r.session.resetAt, Date.parse('2026-08-05T17:00:00Z'));
});

t('ลิมิตตาม preset: max5 = 88000', () => {
  const dir = fixture({ 'a.jsonl': [claudeLine(NOW - 60000, { input_tokens: 10, output_tokens: 0 })] });
  eq(run(prov(dir)).session.limit, 88000);
});

t('calibration ชนะ preset และตั้งธง calibrated', () => {
  const dir = fixture({ 'a.jsonl': [claudeLine(NOW - 60000, { input_tokens: 500, output_tokens: 0 })] });
  const r = run(prov(dir, { calibration: { session: 1000, weekly: 5000 } }));
  eq(r.session.limit, 1000);
  eq(r.weekly.limit, 5000);
  eq(r.session.pct, 50);
  ok(r.calibrated);
});

t('plan auto + บล็อกจบไม่ถึง 3 = estimating (เคสที่เคยโชว์ 100% ผิด)', () => {
  const dir = fixture({ 'a.jsonl': [claudeLine(NOW - 60000, { input_tokens: 10, output_tokens: 0 })] });
  ok(run(prov(dir, { plan: 'auto' })).estimating);
});

t('plan auto + บล็อกจบ ≥3 = ใช้ P90 ของบล็อกที่ผ่านมา', () => {
  const day = 24 * H;
  const lines = [100, 200, 300, 400].map((n, i) =>
    claudeLine(NOW - (i + 1) * day, { input_tokens: n, output_tokens: 0 })
  );
  const dir = fixture({ 'a.jsonl': lines });
  const r = run(prov(dir, { plan: 'auto' }));
  ok(!r.estimating);
  eq(r.session.limit, 400); // P90 ของ [100,200,300,400]
});

t('weekly rolling: นับเฉพาะ 7 วันย้อนหลัง', () => {
  const day = 24 * H;
  const dir = fixture({ 'a.jsonl': [
    claudeLine(NOW - 8 * day, { input_tokens: 999, output_tokens: 0 }),
    claudeLine(NOW - 6 * day, { input_tokens: 100, output_tokens: 0 })
  ] });
  eq(run(prov(dir)).weekly.tokens, 100);
});

t('หน้าต่างจาก live: นับ session ในกรอบของผู้ให้บริการ ไม่ใช่บล็อกที่ตัดเอง', () => {
  const reset = Date.parse('2026-08-05T14:50:00Z'); // รอบจริง 09:50–14:50
  const dir = fixture({ 'a.jsonl': [
    claudeLine(Date.parse('2026-08-05T09:30:00Z'), { input_tokens: 999, output_tokens: 0 }), // ก่อนหน้าต่าง
    claudeLine(Date.parse('2026-08-05T10:00:00Z'), { input_tokens: 100, output_tokens: 0 }),
    claudeLine(Date.parse('2026-08-05T12:00:00Z'), { input_tokens: 50, output_tokens: 0 })
  ] });
  const r = runW(prov(dir), { session: reset });
  eq(r.session.tokens, 150, 'นับเฉพาะที่อยู่ในรอบจริง');
  eq(r.session.resetAt, reset);
  eq(r.session.startedAt, Date.parse('2026-08-05T09:50:00Z'));
  eq(r.windowSource.session, 'live');
});

t('หน้าต่างจาก live: weekly ไม่กวาดของรอบก่อนเข้ามา (เคสขึ้นแดง 97% ทั้งที่จริง 3%)', () => {
  const day = 24 * H;
  const reset = NOW + 6 * day; // รอบใหม่เพิ่งเริ่มเมื่อวาน
  const dir = fixture({ 'a.jsonl': [
    claudeLine(NOW - 3 * day, { input_tokens: 100000, output_tokens: 0 }), // รอบก่อน
    claudeLine(NOW - 2 * H, { input_tokens: 300, output_tokens: 0 }) // รอบนี้
  ] });
  eq(run(prov(dir)).weekly.tokens, 100300, 'ไม่มี hint = rolling 7 วัน กวาดของรอบก่อนมาด้วย');
  const r = runW(prov(dir), { weekly: reset });
  eq(r.weekly.tokens, 300);
  eq(r.weekly.resetAt, reset);
  eq(r.windowSource.weekly, 'live');
});

t('หน้าต่างจาก live: ความยาวรอบเอาตามที่ผู้ให้บริการบอก ไม่ยัด 5 ชม. เสมอ', () => {
  const reset = Date.parse('2026-08-05T13:00:00Z'); // รอบ 3 ชม. = 10:00–13:00
  const dir = fixture({ 'a.jsonl': [
    claudeLine(Date.parse('2026-08-05T09:30:00Z'), { input_tokens: 999, output_tokens: 0 }),
    claudeLine(Date.parse('2026-08-05T11:00:00Z'), { input_tokens: 70, output_tokens: 0 })
  ] });
  eq(runW(prov(dir), { session: reset }).session.tokens, 1069, 'ค่าเริ่มต้น 5 ชม. กวาด 09:30 มาด้วย');
  eq(runW(prov(dir), { session: reset, sessionMs: 3 * H }).session.tokens, 70);
});

t('ไม่มี hint = ใช้บล็อก 5 ชม. + rolling เหมือนเดิม (กันถอยหลัง)', () => {
  const dir = fixture({ 'a.jsonl': [claudeLine(NOW - 60000, { input_tokens: 10, output_tokens: 0 })] });
  eq(run(prov(dir)).windowSource, { session: 'block', weekly: 'rolling' });
});

t('liveLimit ใช้แทน preset แต่ยังแพ้ calibration', () => {
  const dir = fixture({ 'a.jsonl': [claudeLine(NOW - 60000, { input_tokens: 500, output_tokens: 0 })] });
  const r = run(prov(dir, { liveLimit: { session: 2000, weekly: 9000, at: NOW } }));
  eq(r.session.limit, 2000);
  eq(r.weekly.limit, 9000);
  eq(run(prov(dir, { liveLimit: { session: 2000, at: NOW }, calibration: { session: 1000 } })).session.limit, 1000);
});

t('liveLimit ที่เก่าเกิน 14 วันถูกมองข้าม กลับไปใช้ค่าตามแพลน', () => {
  const dir = fixture({ 'a.jsonl': [claudeLine(NOW - 60000, { input_tokens: 500, output_tokens: 0 })] });
  eq(run(prov(dir, { liveLimit: { session: 2000, at: NOW - 15 * 24 * H } })).session.limit, 88000);
});

t('มี liveLimit แล้วไม่ต้องขึ้น "กำลังเรียนรู้" อีก', () => {
  const dir = fixture({ 'a.jsonl': [claudeLine(NOW - 60000, { input_tokens: 10, output_tokens: 0 })] });
  ok(!run(prov(dir, { plan: 'auto', liveLimit: { session: 5000, at: NOW } })).estimating);
});

t('cumulative-max: อ่าน total_token_usage ไม่ใช่ last_token_usage (เคยต่ำกว่าจริง 170 เท่า)', () => {
  const codex = (ts, total, last) => ({
    timestamp: iso(ts),
    type: 'event_msg',
    payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: total, output_tokens: 0 },
      last_token_usage: { input_tokens: last, output_tokens: 0 }
    } }
  });
  const dir = fixture({ 'a.jsonl': [codex(NOW - 20 * 60000, 5000, 5000), codex(NOW - 10 * 60000, 90000, 3000)] });
  eq(run(prov(dir, { aggregation: 'cumulative-max' })).session.tokens, 90000, 'ยอดสะสมสูงสุด');
  eq(run(prov(dir)).session.tokens, 8000, 'โหมด sum ยังอ่านยอดรายเทิร์นเหมือนเดิม');
});

t('หน้าต่างจาก live: weekly ไม่นับการใช้งานที่เลยเวลารีเซ็ตไปแล้ว', () => {
  const reset = NOW - 10 * 60000;
  const dir = fixture({ 'a.jsonl': [
    claudeLine(NOW - 2 * H, { input_tokens: 300, output_tokens: 0 }),
    claudeLine(NOW - 5 * 60000, { input_tokens: 700, output_tokens: 0 }) // เกิดหลังรอบรีเซ็ต
  ] });
  eq(runW(prov(dir), { weekly: reset }).weekly.tokens, 300);
});

t('หน้าต่างจาก live: อัตราเผาผลาญนับจากการใช้งานครั้งแรกในรอบ ไม่ใช่ขอบหน้าต่าง', () => {
  const reset = NOW + 20 * 60000; // รอบ 5 ชม. ที่เหลืออีก 20 นาที (เริ่มมาตั้งแต่ 4 ชม. 40 นาทีก่อน)
  const dir = fixture({ 'a.jsonl': [
    claudeLine(NOW - 30 * 60000, { input_tokens: 250000, output_tokens: 0 }),
    claudeLine(NOW - 10 * 60000, { input_tokens: 250000, output_tokens: 0 })
  ] });
  const r = runW(prov(dir), { session: reset });
  ok(r.burnPerHour > 900000, 'ใช้ 500k ใน 30 นาที ควรได้ราว 1M/ชม. แต่ได้ ' + r.burnPerHour);
});

console.log('\nliveusage.js (Codex)');

function codexLine(ts, rateLimits) {
  return { timestamp: iso(ts), type: 'event_msg', payload: { type: 'token_count', rate_limits: rateLimits } };
}
const secs = (ms) => Math.round(ms / 1000);

t('หน้าต่าง 7 วันที่ยังไม่หมดอายุ → weekly พร้อม resetAt', () => {
  const reset = Date.now() + 2 * 24 * H;
  const dir = fixture({ 'r.jsonl': [
    codexLine(Date.now() - H, { primary: { used_percent: 42.5, window_minutes: 10080, resets_at: secs(reset) } })
  ] });
  const r = fetchCodexLive([dir]);
  eq(r.weekly.pct, 42.5);
  eq(r.weekly.resetAt, secs(reset) * 1000);
  eq(r.session, null);
});

t('หน้าต่างหมดอายุแล้ว → null ห้ามเดา 0% (โควตาแชร์กับฝั่งเว็บ)', () => {
  const dir = fixture({ 'r.jsonl': [
    codexLine(Date.now() - 20 * 24 * H, { primary: { used_percent: 69, window_minutes: 10080, resets_at: secs(Date.now() - 14 * 24 * H) } })
  ] });
  eq(fetchCodexLive([dir]), null);
});

t('หน้าต่าง ≤10 ชม. map เป็น session', () => {
  const reset = Date.now() + 2 * H;
  const dir = fixture({ 'r.jsonl': [
    codexLine(Date.now() - H, { primary: { used_percent: 55, window_minutes: 300, resets_at: secs(reset) } })
  ] });
  const r = fetchCodexLive([dir]);
  eq(r.session.pct, 55);
  eq(r.weekly, null);
});

t('ใช้บรรทัด rate_limits ล่าสุดในไฟล์', () => {
  const reset = Date.now() + 2 * 24 * H;
  const dir = fixture({ 'r.jsonl': [
    codexLine(Date.now() - 2 * H, { primary: { used_percent: 30, window_minutes: 10080, resets_at: secs(reset) } }),
    codexLine(Date.now() - 1 * H, { primary: { used_percent: 55, window_minutes: 10080, resets_at: secs(reset) } })
  ] });
  eq(fetchCodexLive([dir]).weekly.pct, 55);
});

t('ไฟล์ไม่มี rate_limits เลย → null', () => {
  const dir = fixture({ 'r.jsonl': [claudeLine(Date.now() - H, { input_tokens: 10, output_tokens: 0 })] });
  eq(fetchCodexLive([dir]), null);
});

console.log('\nliveusage.js (ตัวแปลงโควตาจากเว็บ)');

t('rate-limits ตรง ๆ: เหลือ 20/80 = ใช้ไป 75% หน้าต่างสั้นเป็น session', () => {
  const r = parseWebRateLimits({ windowSizeSeconds: 7200, remainingQueries: 20, totalQueries: 80 }, NOW);
  eq(Math.round(r.session.pct), 75);
  eq(r.weekly, null);
});

t('ไม่บอกขนาดหน้าต่าง → จัดเป็นรายสัปดาห์ (ช่องเดียวกับปักหมุด)', () => {
  const r = parseWebRateLimits({ remainingTokens: 30, totalTokens: 100 }, NOW);
  eq(Math.round(r.weekly.pct), 70);
  eq(r.session, null);
});

t('ซ้อนหลายชั้นหลายหน้าต่าง → เอาตัวที่ใช้ไปมากสุดของแต่ละกลุ่ม', () => {
  const r = parseWebRateLimits({
    a: { windowSizeSeconds: 86400, remainingQueries: 90, totalQueries: 100 },
    b: { windowSizeSeconds: 604800, remainingQueries: 10, totalQueries: 100 }
  }, NOW);
  eq(Math.round(r.weekly.pct), 90);
});

t('waitTimeSeconds → resetAt = ตอนนี้ + เวลารอ', () => {
  const r = parseWebRateLimits({ windowSizeSeconds: 7200, remainingQueries: 0, totalQueries: 80, waitTimeSeconds: 3600 }, NOW);
  eq(r.session.pct, 100);
  eq(r.session.resetAt, NOW + 3600 * 1000);
});

t('แบบหน้า Usage: usedPercent + เวลารีเซ็ต ISO → weekly', () => {
  const r = parseWebRateLimits({ imagine: { usedPercent: 63, resetsAt: new Date(NOW + 3 * 24 * H).toISOString() } }, NOW);
  eq(r.weekly.pct, 63);
  eq(r.weekly.resetAt, NOW + 3 * 24 * H);
  eq(r.session, null);
});

t('เวลารีเซ็ตเป็น epoch วินาที → แปลงเป็น ms', () => {
  const r = parseWebRateLimits({ percentUsed: 40, resetTime: Math.floor((NOW + 24 * H) / 1000) }, NOW);
  eq(r.weekly.pct, 40);
  eq(r.weekly.resetAt, Math.floor((NOW + 24 * H) / 1000) * 1000);
});

t('โครงไม่รู้จัก/ว่าง → null ห้ามเดา', () => {
  eq(parseWebRateLimits({ hello: 'world' }, NOW), null);
  eq(parseWebRateLimits(null, NOW), null);
  eq(parseWebRateLimits({ totalQueries: 0, remainingQueries: 0 }, NOW), null);
});

t('parseWebText: JSON ตรง ๆ ก็อ่านได้', () => {
  const r = parseWebText('{"usedPercent":63}', NOW);
  eq(r.weekly.pct, 63);
});

t('parseWebText: payload แบบ RSC (JSON ฝังในข้อความ + escape) → เจอ 63%', () => {
  const iso = new Date(NOW + 3 * 24 * H).toISOString();
  const rsc = `0:["$","div",null]\n1:I{"usage":[{\\"name\\":\\"imagine\\",\\"usedPercent\\":63,\\"resetsAt\\":\\"${iso}\\"}]}\n2:null`;
  const r = parseWebText(rsc, NOW);
  eq(r.weekly.pct, 63);
  eq(r.weekly.resetAt, NOW + 3 * 24 * H);
});

t('แบบ ChatGPT: used_percent + window_minutes → จัดกลุ่มตามขนาดหน้าต่าง', () => {
  const reset = secs(NOW + 2 * 24 * H);
  const r = parseWebText(JSON.stringify({
    rate_limits: {
      primary: { used_percent: 81, window_minutes: 10080, resets_at: reset },
      secondary: { used_percent: 12, window_minutes: 300 }
    }
  }), NOW);
  eq(r.weekly.pct, 81);
  eq(r.weekly.resetAt, reset * 1000);
  eq(r.session.pct, 12);
});

t('คีย์แบบ "% ที่เหลือ" (remainingPercent) → กลับด้านเป็น % ที่ใช้ไป', () => {
  const r = parseWebRateLimits({ remainingPercent: 0, resetsAt: new Date(NOW + 2 * 24 * H).toISOString() }, NOW);
  eq(r.weekly.pct, 100);
  const r2 = parseWebRateLimits({ percentLeft: 37 }, NOW);
  eq(r2.weekly.pct, 63);
});

t('คู่ used/limit → คำนวณ % เอง', () => {
  const r = parseWebRateLimits({ used: 45, limit: 60, resetsAt: new Date(NOW + 24 * H).toISOString() }, NOW);
  eq(Math.round(r.weekly.pct), 75);
  eq(r.weekly.resetAt, NOW + 24 * H);
});

t('parseWebText: ข้อความไม่มีอะไรเลย → null', () => {
  eq(parseWebText('hello world {"foo":1}', NOW), null);
  eq(parseWebText('', NOW), null);
});

/* ---------- ค่าสดล่าสุดที่ยังใช้อ้างอิงได้ (usableSnapshot) ----------
 * เคสจริง 7 ส.ค. 2026: token ของ Claude Code หมดอายุตอนไม่ได้ใช้ CLI หลายชั่วโมง
 * โหมดสดล้ม การ์ดดิ่งจาก 29% เหลือ 0% เพราะโควตาถูกใช้จากเว็บซึ่งไม่ทิ้ง log ในเครื่อง
 */
console.log('\nliveusage.js — ค่าสดล่าสุด');

t('รอบยังไม่รีเซ็ต → ใช้ค่าเดิมได้ทั้ง session และ weekly', () => {
  const snap = {
    source: 'api',
    session: { pct: 29, resetAt: NOW + 2 * H, windowMs: 5 * H, at: NOW - 10 * 60 * 1000 },
    weekly: { pct: 11, resetAt: NOW + 5 * 24 * H, windowMs: 7 * 24 * H, at: NOW - 10 * 60 * 1000 }
  };
  const r = usableSnapshot(snap, NOW);
  eq(r.session.pct, 29);
  eq(r.weekly.pct, 11);
  eq(r.session.windowMs, 5 * H);
  eq(r.source, 'api');
});

t('รอบที่หมุนไปแล้วต้องทิ้ง — ค่าของรอบเก่าบอกอะไรรอบใหม่ไม่ได้', () => {
  const snap = {
    source: 'api',
    session: { pct: 90, resetAt: NOW - 60 * 1000, at: NOW - 2 * H },
    weekly: { pct: 11, resetAt: NOW + 5 * 24 * H, at: NOW - 2 * H }
  };
  const r = usableSnapshot(snap, NOW);
  eq(r.session, undefined, 'session ที่รีเซ็ตไปแล้วต้องไม่ถูกใช้');
  eq(r.weekly.pct, 11);
});

t('เก่าเกิน 24 ชม. → ไม่ใช้ แม้รอบยังไม่หมด (รายสัปดาห์ยาว 7 วัน)', () => {
  const snap = { source: 'web', weekly: { pct: 63, resetAt: NOW + 3 * 24 * H, at: NOW - 30 * H } };
  eq(usableSnapshot(snap, NOW), null);
});

t('ไม่มีเวลารีเซ็ต หรือ % อ่านไม่ออก → null', () => {
  eq(usableSnapshot({ session: { pct: 50 } }, NOW), null);
  eq(usableSnapshot({ session: { pct: null, resetAt: NOW + H } }, NOW), null);
  eq(usableSnapshot(null, NOW), null);
});

t('โครงแบบ claude.ai: five_hour/seven_day + utilization → แยกช่องถูกจากชื่อคีย์', () => {
  const r = parseWebRateLimits(
    {
      five_hour: { utilization: 29, resets_at: new Date(NOW + 2 * H).toISOString() },
      seven_day: { utilization: 11, resets_at: new Date(NOW + 5 * 24 * H).toISOString() }
    },
    NOW
  );
  eq(r.session.pct, 29);
  eq(r.session.resetAt, NOW + 2 * H);
  eq(r.weekly.pct, 11);
});

t('โครงแบบ claude.ai ที่ห่อไว้อีกชั้น → ยังหาเจอ', () => {
  const r = parseWebText(
    JSON.stringify({ data: { usage: { fiveHour: { utilization: 42, resetsAt: new Date(NOW + H).toISOString() } } } }),
    NOW
  );
  eq(r.session.pct, 42);
});

t('applyStale: ค่าประมาณ 0% แต่เคยวัดได้ 29% → การ์ดต้องไม่ดิ่งเหลือ 0', () => {
  const p = {
    session: { pct: 0, tokens: 0, limit: 545000 },
    weekly: { pct: 37, tokens: 33.91e6, limit: 92e6 }
  };
  const snap = usableSnapshot(
    {
      source: 'api',
      session: { pct: 29, resetAt: NOW + 2 * H, at: NOW - 20 * 60 * 1000 },
      weekly: { pct: 11, resetAt: NOW + 5 * 24 * H, at: NOW - 20 * 60 * 1000 }
    },
    NOW
  );
  liveusage.applyStale(p, snap);
  eq(p.session.pct, 29);
  eq(p.session.liveSource, 'stale');
  eq(p.session.staleAt, NOW - 20 * 60 * 1000);
  // ค่าประมาณสูงกว่าที่เคยวัดได้ = ใช้เพิ่มหลังวัดครั้งสุดท้าย → ค่าประมาณชนะ
  eq(p.weekly.pct, 37);
  eq(p.session.limitFromPct, undefined, 'ห้ามถอดลิมิตกลับจากค่าค้าง');
  eq(p.live, undefined, 'ห้ามประกาศว่าสด');
});

t('applyStale: ค่าค้างจากเว็บของ ChatGPT → หน้าปัดยังยึดรายสัปดาห์เหมือนตอนสด', () => {
  const p = { id: 'chatgpt', session: { pct: 5 }, weekly: { pct: 0 } };
  liveusage.applyStale(p, {
    source: 'web',
    session: { pct: 20, resetAt: NOW + H, at: NOW },
    weekly: { pct: 63, resetAt: NOW + 2 * 24 * H, at: NOW }
  });
  eq(p.webGauge, true, 'ChatGPT: session คือโควตาแชท ไม่ใช่ตัวที่บีบจริง');
  eq(p.weekly.pct, 63);
});

t('applyStale: Claude จากเว็บ → หน้าปัดยังยึดบล็อก 5 ชม. เหมือนโหมด API', () => {
  const p = { id: 'claude', session: { pct: 0, tokens: 0 }, weekly: { pct: 0 }, etaMs: 999 };
  liveusage.applyStale(p, {
    source: 'web',
    session: { pct: 29, resetAt: NOW + 2 * H, at: NOW },
    weekly: { pct: 11, resetAt: NOW + 5 * 24 * H, at: NOW }
  });
  eq(p.webGauge, false);
  eq(p.session.pct, 29);
  eq(p.etaMs, null, 'เวลาที่ทำนายจากลิมิตประมาณขัดกับ % ที่ทับลงไป');
});

t('จำที่มาไว้ด้วย — ค่าจากเว็บห้ามถูกใช้เป็นหน้าต่างนับ token ของ CLI', () => {
  const snap = { source: 'web', weekly: { pct: 63, resetAt: NOW + 2 * 24 * H, at: NOW } };
  eq(usableSnapshot(snap, NOW).source, 'web');
  // ไม่ระบุที่มา = ถือว่ามาจาก API (โครงเดิมก่อนมีฟิลด์นี้)
  eq(usableSnapshot({ weekly: { pct: 5, resetAt: NOW + 2 * 24 * H, at: NOW } }, NOW).source, 'api');
});

console.log('\nhistory.js');

t('record + sparkFrom: เก็บรายชั่วโมงแล้วอ่านกลับเป็นกราฟ 24 ช่อง', () => {
  history._reset();
  const dir = path.join(TMP, 'hist1');
  fs.mkdirSync(dir, { recursive: true });
  const app = { getPath: () => dir };
  const hour = Math.floor(NOW / H) * H;
  history.record(app, [{ id: 'claude', ok: true, hourly: { [hour]: 500, [hour - H]: 200 } }], NOW);
  const bins = history.sparkFrom(app, 'claude', NOW);
  eq(bins.length, 24);
  eq(bins[23], 500);
  eq(bins[22], 200);
  ok(fs.existsSync(path.join(dir, 'history.json')), 'ต้องเขียนไฟล์');
});

t('อ่านไฟล์เดิมกลับได้หลังรีสตาร์ต (จำลองด้วย _reset)', () => {
  const dir = path.join(TMP, 'hist1');
  const app = { getPath: () => dir };
  history._reset();
  const bins = history.sparkFrom(app, 'claude', NOW);
  eq(bins[23], 500);
});

t('ตัดข้อมูลเก่ากว่า 90 วันทิ้ง', () => {
  history._reset();
  const dir = path.join(TMP, 'hist2');
  fs.mkdirSync(dir, { recursive: true });
  const app = { getPath: () => dir };
  const hour = Math.floor(NOW / H) * H;
  const old = hour - 91 * 24 * H;
  history.record(app, [{ id: 'claude', ok: true, hourly: { [old]: 100, [hour]: 50 } }], NOW);
  history.flush(app, NOW + 10 * 60 * 1000);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
  eq(onDisk.providers.claude[String(old)], undefined, 'ค่าเก่าต้องถูกลบ');
  eq(onDisk.providers.claude[String(hour)], 50);
});

/* ---------- อ่านไฟล์ใหญ่ทีละท่อน + อ่านต่อเฉพาะส่วนที่เพิ่ม ----------
 * log ของ Codex ไฟล์เดียวเคยโตถึง 1.7 GB แล้ว readFileSync ทั้งก้อนทำแอปตาย (25 พ.ย. 2026) */
console.log('\nusage.js (ไฟล์ใหญ่)');

t('ไฟล์ใหญ่กว่าท่อนอ่าน 4 MB + ภาษาไทยคร่อมรอยต่อ → นับครบ ไม่เพี้ยน', () => {
  const dir = path.join(TMP, 'big' + seq++);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's.jsonl');
  const pad = JSON.stringify({ type: 'text', text: 'สวัสดีครับ'.repeat(40000) }); // ~1.2 MB ต่อบรรทัด ไม่มี usage
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(pad);
    lines.push(JSON.stringify(claudeLine(NOW - H + i * 60000, { input_tokens: 100, output_tokens: 10 }, 'm' + i)));
  }
  fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8');
  ok(fs.statSync(f).size > 4.5 * 1024 * 1024, 'ไฟล์ทดสอบต้องใหญ่กว่าท่อนอ่าน');
  const r = usage.computeProvider(prov(dir), PLAN_PRESETS, { now: NOW });
  eq(r.totalEvents, 6);
  eq(r.session.tokens, 660);
});

t('บรรทัดยาวเกิน 16 MB ถูกข้ามทั้งบรรทัด บรรทัดถัดไปยังอ่านได้', () => {
  const dir = path.join(TMP, 'big' + seq++);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's.jsonl');
  const huge = '{"type":"tool","output":"' + 'x'.repeat(17 * 1024 * 1024) + '","input_tokens":999999}';
  const good = JSON.stringify(claudeLine(NOW - H, { input_tokens: 5, output_tokens: 5 }, 'g'));
  fs.writeFileSync(f, huge + '\n' + good + '\n', 'utf8');
  const r = usage.computeProvider(prov(dir), PLAN_PRESETS, { now: NOW });
  eq(r.totalEvents, 1);
  eq(r.session.tokens, 10);
});

t('ไฟล์โตขึ้น → อ่านต่อเฉพาะส่วนใหม่ และบรรทัดที่ยังเขียนไม่จบไม่ถูกนับซ้ำ', () => {
  const dir = path.join(TMP, 'big' + seq++);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's.jsonl');
  const L = (i) => JSON.stringify(claudeLine(NOW - H + i * 60000, { input_tokens: 100, output_tokens: 0 }, 'm' + i));
  fs.writeFileSync(f, L(0) + '\n' + L(1), 'utf8'); // บรรทัดสุดท้ายยังไม่มี \n (กำลังเขียน)
  const p = prov(dir);
  eq(usage.computeProvider(p, PLAN_PRESETS, { now: NOW }).session.tokens, 200);
  fs.appendFileSync(f, '\n' + L(2) + '\n', 'utf8');
  const r = usage.computeProvider(p, PLAN_PRESETS, { now: NOW });
  eq(r.totalEvents, 3, 'm1 ต้องไม่ถูกนับซ้ำ');
  eq(r.session.tokens, 300);
});

t('cumulative-max อ่านต่อได้: ค่าสะสมสูงสุดขยับตามบรรทัดใหม่', () => {
  const dir = path.join(TMP, 'big' + seq++);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'rollout.jsonl');
  const C = (ts, n) => JSON.stringify({ timestamp: iso(ts), payload: { info: { total_token_usage: { input_tokens: n, output_tokens: 0 } } } });
  fs.writeFileSync(f, C(NOW - H, 1000) + '\n', 'utf8');
  const p = prov(dir, { aggregation: 'cumulative-max' });
  eq(usage.computeProvider(p, PLAN_PRESETS, { now: NOW }).session.tokens, 1000);
  fs.appendFileSync(f, C(NOW - H + 60000, 4000) + '\n', 'utf8');
  const r = usage.computeProvider(p, PLAN_PRESETS, { now: NOW });
  eq(r.totalEvents, 1);
  eq(r.session.tokens, 4000);
});

/* ---------- Gemini CLI ---------- */
console.log('\nusage.js (Gemini CLI)');

function geminiMsg(id, ts, tokens) {
  return { id, type: 'gemini', timestamp: iso(ts), content: 'x', model: 'gemini-2.5-pro', tokens };
}
function geminiDir(files) {
  const dir = path.join(TMP, 'gm' + seq++, 'abc123', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, 'utf8');
  return path.dirname(path.dirname(dir)); // = ~/.gemini/tmp
}

t('Gemini: cached อยู่ใน input แล้ว ต้องหักออก ไม่งั้นแคชถูกนับสองรอบ', () => {
  // ตัวเลขจาก session จริง: total = input + output (cached เป็นส่วนหนึ่งของ input)
  const ev = usage.parseGeminiText(JSON.stringify({
    sessionId: 's1',
    messages: [
      { id: 'u1', type: 'user', timestamp: iso(NOW - H), content: 'hi' },
      geminiMsg('g1', NOW - H, { input: 64754, output: 509, cached: 58371, thoughts: 0, tool: 0, total: 65263 })
    ]
  }), NOW);
  eq(ev.length, 1, 'ข้อความของผู้ใช้ไม่มี tokens ต้องไม่ถูกนับ');
  eq(ev[0].input, 64754 - 58371);
  eq(ev[0].cacheRead, 58371);
  eq(ev[0].input + ev[0].output + ev[0].cacheRead, 65263, 'รวมกลับต้องเท่ากับ total');
});

t('Gemini: thoughts คิดเป็น output', () => {
  const ev = usage.parseGeminiText(JSON.stringify({
    sessionId: 's1',
    messages: [geminiMsg('g1', NOW, { input: 22629, output: 805, cached: 0, thoughts: 3174, tool: 0, total: 26608 })]
  }), NOW);
  eq(ev[0].output, 805 + 3174);
  eq(ev[0].input + ev[0].output, 26608);
});

t('Gemini: แบบ JSONL ข้อความเดิมถูกเขียนซ้ำ → ยึดรุ่นล่าสุด ไม่นับซ้ำ', () => {
  const lines = [
    { sessionId: 's2', startTime: iso(NOW - H) },
    geminiMsg('g1', NOW - H, { input: 100, output: 1, cached: 0 }),
    geminiMsg('g1', NOW - H, { input: 100, output: 50, cached: 0 }),
    geminiMsg('g2', NOW, { input: 10, output: 5, cached: 0 })
  ].map((l) => JSON.stringify(l));
  const ev = usage.parseGeminiText(lines.join('\n') + '\n{"broken', NOW);
  eq(ev.length, 2);
  eq(ev[0].output, 50);
});

t('Gemini: computeProvider อ่าน session-*.json ใน tmp และไม่หยิบไฟล์อื่น', () => {
  const root = geminiDir({
    'session-2026-08-05T11-00-aaaa.json': JSON.stringify({
      sessionId: 's3',
      messages: [geminiMsg('g1', NOW - H, { input: 1000, output: 200, cached: 0 })]
    }),
    // /compress เขียนไฟล์ใหม่ด้วย sessionId เดิม — ข้อความเดิมต้องไม่ถูกนับสองรอบ
    'session-2026-08-05T12-00-aaaa.json': JSON.stringify({
      sessionId: 's3',
      messages: [
        geminiMsg('g1', NOW - H, { input: 1000, output: 200, cached: 0 }),
        geminiMsg('g2', NOW - 0.5 * H, { input: 300, output: 100, cached: 0 })
      ]
    }),
    'checkpoint-foo.json': JSON.stringify({ messages: [geminiMsg('x', NOW, { input: 999999, output: 0 })] }),
    'logs.json': JSON.stringify([{ tokens: { input: 999999 } }])
  });
  const r = usage.computeProvider(
    { id: 'gemini', name: 'Gemini', roots: [root], aggregation: 'gemini', cacheReadWeight: 0.1, plan: 'auto' },
    PLAN_PRESETS, { now: NOW }
  );
  eq(r.state, 'ok');
  eq(r.files, 2);
  eq(r.totalEvents, 2);
  eq(r.session.tokens, 1600);
});

t('config: providers.grok ที่ค้างใน config.json เดิมถูกลบตอนโหลด', () => {
  const dir = path.join(TMP, 'cfg' + seq++);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    pricing: { claude: 150, grok: 80 },
    providers: { grok: { id: 'grok', name: 'Grok', enabled: true, liveWeb: true }, claude: { plan: 'max20' } }
  }), 'utf8');
  const cfg = require('../src/config').load({ getPath: () => dir });
  eq(cfg.providers.grok, undefined);
  eq(cfg.pricing.grok, undefined);
  eq(cfg.providers.claude.plan, 'max20', 'ค่าอื่นของผู้ใช้ต้องอยู่ครบ');
  ok(cfg.providers.gemini, 'ต้องมีการ์ด Gemini มาแทน');
  eq(cfg.retired, ['grok']);
  eq(Object.keys(JSON.parse(JSON.stringify(cfg))).includes('retired'), false, 'retired ห้ามถูกเขียนลงไฟล์');
});

/* ---------- สรุปผล ---------- */
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nผ่าน ${pass} / ${pass + fail}`);
if (fail > 0) process.exit(1);
