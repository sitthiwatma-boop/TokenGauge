'use strict';
/**
 * history.js — เก็บสรุปการใช้งานรายชั่วโมงลง history.json ใน userData
 *
 * เหตุผล: ข้อมูลทั้งหมดของแอปมาจากไฟล์ log ของ CLI แต่ละเจ้า ซึ่งถูกลบ/หมุนเวียนได้
 * เก็บสำเนารายชั่วโมงไว้เอง 90 วัน ประวัติจะไม่หายแม้ log ต้นทางหาย
 *
 * โครงไฟล์: { providers: { claude: { "<ms ต้นชั่วโมง>": tokens, ... }, ... } }
 * เขียนไฟล์เฉพาะเมื่อมีค่าเปลี่ยน และเว้นอย่างน้อย 5 นาทีต่อครั้ง — ไม่เขียนทุกรอบรีเฟรช
 */
const fs = require('fs');
const path = require('path');

const KEEP_MS = 90 * 24 * 3600 * 1000;
const WRITE_MIN_MS = 5 * 60 * 1000;

let cache = null;
let dirty = false;
let lastWrite = 0;

function file(app) {
  return path.join(app.getPath('userData'), 'history.json');
}

function load(app) {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(app), 'utf8'));
    if (!cache || typeof cache !== 'object' || !cache.providers) cache = { providers: {} };
  } catch {
    cache = { providers: {} };
  }
  return cache;
}

/** รับผลจาก computeAll (แต่ละ provider มี .hourly) แล้ว merge เฉพาะช่วงที่เปลี่ยน */
function record(app, providers, now = Date.now()) {
  const h = load(app);
  for (const p of providers || []) {
    if (!p.ok || !p.hourly) continue;
    const slot = h.providers[p.id] || (h.providers[p.id] = {});
    for (const [k, v] of Object.entries(p.hourly)) {
      if (slot[k] !== v) {
        slot[k] = v;
        dirty = true;
      }
    }
    for (const k of Object.keys(slot)) {
      if (Number(k) < now - KEEP_MS) {
        delete slot[k];
        dirty = true;
      }
    }
  }
  if (dirty && now - lastWrite >= WRITE_MIN_MS) flush(app, now);
}

function flush(app, now = Date.now()) {
  if (!cache || !dirty) return;
  try {
    fs.writeFileSync(file(app), JSON.stringify(cache), 'utf8');
    lastWrite = now;
    dirty = false;
  } catch { /* ดิสก์เต็ม/ล็อก — ลองใหม่รอบหน้า */ }
}

/** กราฟ 24 ชั่วโมงจากประวัติที่เก็บเอง (ช่องละ 1 ชม. ช่องสุดท้าย = ชั่วโมงปัจจุบัน) */
function sparkFrom(app, id, now = Date.now()) {
  const slot = load(app).providers[id];
  if (!slot || !Object.keys(slot).length) return null;
  const start = Math.floor(now / 3600000) * 3600000 - 23 * 3600000;
  return Array.from({ length: 24 }, (_, i) => slot[start + i * 3600000] || 0);
}

/** ข้อมูลรายชั่วโมงทั้งหมด — ให้หน้าประวัติเอาไปวาดกราฟ */
function slots(app) {
  return load(app).providers;
}

/** ใช้ในเทสต์ — ล้าง state ใน memory */
function _reset() {
  cache = null;
  dirty = false;
  lastWrite = 0;
}

module.exports = { record, flush, sparkFrom, slots, _reset };
