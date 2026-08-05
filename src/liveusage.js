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

const CACHE_MS = 45 * 1000; // กันยิง API ถี่เกิน แม้ผู้ใช้ตั้งรีเฟรช 10 วิ

let cache = { at: 0, data: null, error: null };

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
  try {
    const json = await request(readAccessToken());
    const data = {
      session: normalize(windowOf(json, ['five_hour', 'fiveHour', 'session'])),
      weekly: normalize(windowOf(json, ['seven_day', 'sevenDay', 'weekly'])),
      weeklyModel: normalize(windowOf(json, ['seven_day_opus', 'seven_day_oauth_apps', 'seven_day_sonnet']))
    };
    if (!data.session && !data.weekly) throw new Error('โครงสร้างคำตอบ API ไม่ตรงที่คาด');
    cache = { at: now, data, error: null };
    return data;
  } catch (err) {
    cache = { at: now, data: null, error: String(err.message || err) };
    throw err;
  }
}

module.exports = { fetchLive };
