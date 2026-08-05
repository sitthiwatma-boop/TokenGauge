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
const { fetchCodexLive } = require('../src/liveusage');
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

/* ---------- สรุปผล ---------- */
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nผ่าน ${pass} / ${pass + fail}`);
if (fail > 0) process.exit(1);
