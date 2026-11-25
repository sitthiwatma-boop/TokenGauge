'use strict';
/**
 * webquota.js — % โควตาสดจากเว็บของผู้ให้บริการ ผ่าน session ที่ผู้ใช้ล็อกอิน
 * "ในหน้าต่างของแอปเอง" (opt-in ทดลอง, ปิดเป็นค่าเริ่มต้น) — Claude, ChatGPT และ Gemini
 *
 * วิธีทำงานต่อผู้ให้บริการหนึ่งราย:
 *   1) ผู้ใช้ล็อกอินเว็บในหน้าต่างของแอปหนึ่งครั้ง — cookie อยู่ใน partition ส่วนตัวของแอป
 *   2) ระหว่างหน้าต่างเปิดอยู่ แอปดู network เฉพาะโดเมนของเจ้านั้น เพื่อเรียนรู้ว่า
 *      หน้า usage ดึงข้อมูลจาก endpoint ไหน (จำ url + method + body + header ที่จำเป็น)
 *   3) ทุกรอบรีเฟรช แอป replay คำขอนั้นเองผ่าน session เดิม
 *
 * เงื่อนไขที่ต้องรักษา (ข้อยกเว้นที่ผู้ใช้อนุมัติ ส.ค. 2026 — ดู CLAUDE.md):
 *   - ห้ามแตะ cookie/credential ของเบราว์เซอร์อื่นเด็ดขาด
 *   - แต่ละ session ส่งคำขอหาเว็บเจ้าของ session เท่านั้น ห้าม log/เก็บ/ส่งไปที่อื่น
 *   - endpoint ไม่ทางการ พังได้ — แอปต้องถอยไปค่าปักหมุด/ค่าประมาณเองเสมอ
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { parseWebText, parseGeminiUsagePage } = require('./liveusage');

// ใช้ UA ของ Firefox กับทุก session — Google ปฏิเสธหน้าล็อกอินใน embedded browser
// และจับได้ถ้า header กับ navigator.userAgent ไม่ตรงกัน จึงต้องเป็น Firefox ทุกจุด
// พร้อมตัด client hints (sec-ch-ua*) ที่ Firefox จริงไม่ส่ง — cookie ของ Cloudflare
// ก็ผูกกับ UA นี้ทั้งตอนล็อกอินและตอน fetch สอดคล้องกัน
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

const CACHE_MS = 120 * 1000;
const STALE_MS = 15 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;

const PROVIDERS = {
  // claude.ai — ทางเลือกแทนโหมด API เมื่อ token ของ Claude Code หมดอายุ
  // (Claude Code ต่ออายุ token ให้เฉพาะตอนใช้ CLI คนที่ใช้ฝั่งเว็บเป็นหลักจึงสดไม่ได้เลย)
  // เปิดหน้า usage ให้ตั้งแต่แรกเพื่อให้ตัวเรียนรู้ endpoint ได้ของจริงทันทีที่ล็อกอินเสร็จ
  claude: {
    partition: 'persist:claudeweb',
    home: 'https://claude.ai/settings/usage',
    origin: 'https://claude.ai',
    urlRe: /^https:\/\/(www\.)?claude\.ai\//,
    cookieDomains: [/(^|\.)claude\.ai$/, /(^|\.)anthropic\.com$/],
    fallbackTries: [] // endpoint ไม่ทางการ เดาไม่ได้ — พึ่งการเรียนรู้จากหน้า usage เท่านั้น
  },
  chatgpt: {
    partition: 'persist:chatgptweb',
    home: 'https://chatgpt.com/',
    origin: 'https://chatgpt.com',
    urlRe: /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//,
    cookieDomains: [/(^|\.)chatgpt\.com$/, /(^|\.)openai\.com$/],
    fallbackTries: [], // ไม่มีทางเดาที่เชื่อได้ — พึ่งการเรียนรู้จากหน้า usage เท่านั้น
    // backend-api ของ ChatGPT ไม่รับ cookie อย่างเดียว ต้องมี Bearer token ที่หน้าเว็บ
    // ขอจาก endpoint นี้ด้วย cookie — แอปทำแบบเดียวกัน (token อยู่ในหน่วยความจำเท่านั้น)
    bearerFrom: 'https://chatgpt.com/api/auth/session'
  },
  // gemini.google.com — หน้า usage ใช้ batchexecute ที่ผูก token ต่อหน้า replay ไม่ได้
  // จึงอ่าน "ข้อความบนหน้า" จากหน้าต่างซ่อนทางเดียว (ผู้ใช้อนุมัติ 25 พ.ย. 2026 ดู CLAUDE.md)
  // hl=th ตายตัว — ตัวแปลงยืนยันกับหน้าภาษาไทยของจริงแล้ว ส่วนภาษาอังกฤษยังเป็นการเดา
  gemini: {
    partition: 'persist:geminiweb',
    home: 'https://gemini.google.com/usage?hl=th',
    origin: 'https://gemini.google.com',
    urlRe: /^https:\/\/gemini\.google\.com\//,
    cookieDomains: [/(^|\.)google\.com$/],
    // cookie ล็อกอินของ Google ชื่อ SID / __Secure-1PSID — ไม่เข้าแพทเทิร์นกลางของ hasSession
    sessionCookie: /^(SID|__Secure-[13]PSID)$/,
    learn: false, // ไม่ต้องเรียนรู้ endpoint — คำตอบของ Google อาจถูกแกะผิดเป็น % มั่ว ๆ
    fallbackTries: [],
    domUsage: 'https://gemini.google.com/usage?hl=th',
    domParse: parseGeminiUsagePage
  }
};

/* สถานะแยกรายผู้ให้บริการ */
const state = {};
function st(id) {
  if (!PROVIDERS[id]) throw new Error(`webquota: ไม่รู้จัก "${id}"`);
  if (!state[id]) {
    state[id] = {
      ses: null,
      loginWin: null,
      discovered: null,
      discoveredScore: -1,
      cache: { at: 0, data: null, error: null },
      lastGood: { at: 0, data: null },
      backoffUntil: 0,
      sniffLog: null, // บันทึก network ของหน้าต่างล็อกอินรอบล่าสุด (เขียนลงไฟล์ตอนปิดหน้าต่าง)
      dom: { at: 0, data: null, inflight: null }, // ค่าที่อ่านจากหน้าเว็บ (แคชนานกว่าปกติ)
      bearer: { at: 0, token: null } // token ชั่วคราวในหน่วยความจำ — ห้ามเขียนลงดิสก์
    };
  }
  return state[id];
}

function getSes(id) {
  const s = st(id);
  if (!s.ses) {
    s.ses = session.fromPartition(PROVIDERS[id].partition);
    s.ses.setUserAgent(UA);
    s.ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, cb) => {
      const h = { ...details.requestHeaders };
      for (const k of Object.keys(h)) {
        if (/^sec-ch-ua/i.test(k)) delete h[k];
      }
      cb({ requestHeaders: h });
    });
  }
  return s.ses;
}

let onDiscoverCb = null; // (id, endpoint) => void — ให้ main บันทึกลง config

function setOnDiscover(fn) {
  onDiscoverCb = fn;
}

function setDiscovered(id, d) {
  const s = st(id);
  s.discovered = d && d.url ? d : null;
  // ค่าที่โหลดมาให้คะแนนต่ำไว้ — เคยจำผิดเป็นโควตาแชทมาแล้ว ต้องเปิดทางให้ของที่ดีกว่าแทนได้
  s.discoveredScore = s.discovered ? 1 : -1;
}

/* ---------- หน้าต่างล็อกอิน + ตัวเรียนรู้ endpoint ---------- */

/** เก็บเฉพาะ header ที่จำเป็นต่อการ replay — ตัด cookie/authorization ทิ้ง (session จัดการเอง) */
function safeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/^(accept$|accept-language|content-type|rsc|next-router-state-tree|next-url|x-)/i.test(k)) {
      if (/authorization|cookie/i.test(k)) continue;
      out[k] = v;
    }
  }
  return out;
}

const SKIP_URL = /\/_next\/static\/|\.(js|css|map|woff2?|png|jpe?g|gif|svg|ico|mp4|webm)(\?|$)/i;

function scoreOf(req, parsed) {
  let s = 0;
  if (/rate|usage|limit|subscription|quota/i.test(req.url)) s += 2;
  if (parsed.weekly) s += 2;
  if (parsed.weekly?.resetAt || parsed.session?.resetAt) s += 1;
  return s;
}

/* ---------- บันทึกสิ่งที่ตัวเรียนรู้เห็น ----------
 * endpoint ของทุกเจ้าไม่ทางการและเปลี่ยนบ่อย เวลาเรียนรู้ไม่เจอ (เคยเจอหน้า usage
 * ใช้คนละ endpoint กับหน้าแชท แอปเลยจำแต่โควตารอบสั้น แล้วการ์ดถอยไปใช้ค่าปักหมุดเงียบ ๆ)
 * ต้องเห็นของจริงถึงจะรู้ว่าต้องแกะยังไง
 * ไฟล์อยู่ใน userData ของเครื่องนี้เท่านั้น ไม่ถูกส่งออกไปไหน และค่าที่หน้าตาเหมือน
 * token/cookie ถูกปิดบังก่อนเขียนเสมอ (หน้าเว็บพวกนี้ส่ง accessToken มากับ JSON ด้วย)
 */
const SNIFF_MAX = 80; // จำนวนคำขอที่บันทึก — พอเห็นภาพหน้า usage โดยไฟล์ไม่บวม
const SNIFF_BODY = 3000; // ตัวอักษรต่อคำตอบหนึ่งรายการ
const SECRET_RE = /("[^"]*(?:token|secret|password|authorization|cookie|api[-_]?key)[^"]*"\s*:\s*)"[^"]*"/gi;

function maskSecrets(s) {
  return String(s).replace(SECRET_RE, '$1"***"');
}

function writeSniffLog(id) {
  const s = st(id);
  if (!s.sniffLog?.length) return;
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), `debug-sniff-${id}.txt`),
      s.sniffLog.join('\n'),
      'utf8'
    );
  } catch { /* เขียน debug ไม่ได้ ไม่เป็นไร */ }
}

function attachSniffer(id, wc) {
  const s = st(id);
  const dbg = wc.debugger;
  dbg.attach('1.3');
  s.sniffLog = [`=== network ของหน้าต่างล็อกอิน ${id} (ค่าที่เหมือน token ถูกปิดบังแล้ว) ===`];
  const reqs = new Map(); // requestId → { url, method, postData, headers }
  dbg.on('message', async (_e, method, params) => {
    try {
      if (method === 'Network.requestWillBeSent') {
        const r = params.request;
        if (PROVIDERS[id].urlRe.test(r.url) && !SKIP_URL.test(r.url)) {
          reqs.set(params.requestId, {
            url: r.url,
            method: r.method,
            postData: r.postData || null,
            headers: safeHeaders(r.headers)
          });
        }
      } else if (method === 'Network.responseReceived') {
        // สนใจเฉพาะคำตอบที่เป็นข้อความ/JSON/RSC — ตัดไฟล์สื่อออกตั้งแต่ต้น
        const req = reqs.get(params.requestId);
        if (!req) return;
        const mime = params.response?.mimeType || '';
        if (!/json|text|x-component/i.test(mime)) {
          if (s.sniffLog.length < SNIFF_MAX) {
            s.sniffLog.push(`--- ${req.method} ${req.url}\n[ข้าม: mimeType ${mime}]`);
          }
          reqs.delete(params.requestId);
          return;
        }
        req.mime = mime;
      } else if (method === 'Network.loadingFinished') {
        const req = reqs.get(params.requestId);
        if (!req) return;
        reqs.delete(params.requestId);
        const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        const parsed = parseWebText(text);
        if (s.sniffLog.length < SNIFF_MAX) {
          const sc = parsed ? scoreOf(req, parsed) : -1;
          s.sniffLog.push(
            `--- ${req.method} ${req.url}\n` +
              `mime ${req.mime} · ${text.length} ตัวอักษร · ` +
              (parsed ? `แกะได้ ${JSON.stringify(parsed)} (คะแนน ${sc})` : 'แกะไม่ออก') +
              (req.postData ? `\nbody ที่ส่งไป: ${maskSecrets(req.postData).slice(0, 400)}` : '') +
              `\n${maskSecrets(text).slice(0, SNIFF_BODY)}`
          );
        }
        if (!parsed) return;
        const sc = scoreOf(req, parsed);
        if (sc > s.discoveredScore) {
          s.discovered = req;
          s.discoveredScore = sc;
          s.cache = { at: 0, data: null, error: null }; // ให้รอบรีเฟรชถัดไปใช้ endpoint ใหม่ทันที
          if (onDiscoverCb) onDiscoverCb(id, req);
        }
      }
    } catch { /* body หายไปแล้ว/อ่านไม่ได้ — ข้าม */ }
  });
  dbg.sendCommand('Network.enable').catch(() => {});
  wc.once('destroyed', () => {
    try { dbg.detach(); } catch { /* หลุดไปแล้ว */ }
  });
}

/** เปิดหน้าต่างล็อกอิน — resolve เมื่อผู้ใช้ปิดหน้าต่าง */
function openLogin(id, parent) {
  const s = st(id);
  return new Promise((resolve) => {
    if (s.loginWin && !s.loginWin.isDestroyed()) {
      s.loginWin.focus();
      return resolve(false);
    }
    getSes(id); // ให้ UA ถูกตั้งก่อนหน้าต่างโหลด
    s.loginWin = new BrowserWindow({
      width: 520,
      height: 760,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      autoHideMenuBar: true,
      title: `ล็อกอิน ${new URL(PROVIDERS[id].home).host} — เสร็จแล้วปิดหน้าต่างนี้ได้เลย`,
      webPreferences: {
        partition: PROVIDERS[id].partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    s.loginWin.loadURL(PROVIDERS[id].home);
    try {
      if (PROVIDERS[id].learn !== false) attachSniffer(id, s.loginWin.webContents); // เรียนรู้ endpoint หน้า usage ถ้าผู้ใช้เปิดดู
    } catch (err) {
      // debugger attach ไม่ได้ = ไม่มีทางเรียนรู้ endpoint เลย ฟีเจอร์หลักยังทำงานด้วย
      // fallback ก็จริง แต่ห้ามเงียบ ไม่งั้นไล่บั๊กตาบอด (เคยนั่งหาว่าทำไมไม่เรียนรู้สักที)
      s.sniffLog = [`=== attach debugger ไม่สำเร็จ: ${String(err.message || err)}`];
    }
    s.loginWin.on('closed', () => {
      s.loginWin = null;
      s.cache = { at: 0, data: null, error: null }; // ล็อกอินใหม่แล้ว ให้ถามซ้ำได้ทันที
      s.backoffUntil = 0;
      writeSniffLog(id); // ทิ้งบันทึกไว้ให้ไล่ดูตอนเรียนรู้ไม่เจอ
      resolve(true);
    });
  });
}

/** มี cookie ที่หน้าตาเหมือน session ของเจ้านั้นอยู่ใน partition ไหม */
async function hasSession(id) {
  try {
    const cookies = await getSes(id).cookies.get({});
    return cookies.some(
      (c) =>
        PROVIDERS[id].cookieDomains.some((re) => re.test(c.domain || '')) &&
        (PROVIDERS[id].sessionCookie || /sso|session|auth|token/i).test(c.name)
    );
  } catch {
    return false;
  }
}

/** ล้าง session ของเจ้านั้นออกจากแอปทั้งหมด */
async function logout(id) {
  const s = st(id);
  await getSes(id).clearStorageData();
  s.cache = { at: 0, data: null, error: null };
  s.lastGood = { at: 0, data: null };
  s.dom = { at: 0, data: null, inflight: null };
  s.backoffUntil = 0;
}

/* ---------- ดึงข้อมูลสด ---------- */

/** ขอ Bearer token สดจาก session (เฉพาะเจ้าที่ต้องใช้) — เก็บในหน่วยความจำ ~5 นาที */
async function getBearer(id) {
  const p = PROVIDERS[id];
  if (!p.bearerFrom) return null;
  const s = st(id);
  const now = Date.now();
  if (s.bearer.token && now - s.bearer.at < 5 * 60 * 1000) return s.bearer.token;
  try {
    const res = await getSes(id).fetch(p.bearerFrom, {
      credentials: 'include',
      signal: AbortSignal.timeout(10000)
    });
    if (res.status !== 200) {
      s.bearer = { at: now, token: null };
      return null;
    }
    const j = await res.json();
    s.bearer = { at: now, token: j?.accessToken || j?.access_token || null };
    return s.bearer.token;
  } catch {
    return null;
  }
}

/** ยิงคำขอหนึ่งรายการ — d = { url, method, postData, headers? } (ไปโดเมนของเจ้านั้นเท่านั้น) */
async function requestOnce(id, d) {
  const { origin } = PROVIDERS[id];
  const headers = { Origin: origin, Referer: origin + '/', ...(d.headers || {}) };
  const hasBody = d.method !== 'GET' && d.method !== 'HEAD' && d.postData;
  if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  const bearer = await getBearer(id);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return getSes(id)
    .fetch(d.url, {
      method: d.method,
      credentials: 'include',
      headers,
      body: hasBody ? d.postData : undefined,
      signal: AbortSignal.timeout(10000)
    })
    .then(async (res) => {
      if (res.status !== 200) return { status: res.status };
      return { status: 200, text: await res.text() };
    });
}

/* ---------- อ่านตัวเลขจากหน้าเว็บโดยตรง (เจ้าที่ endpoint replay ไม่ได้) ----------
 * เปิดหน้า usage ในหน้าต่างที่ซ่อนไว้ (session เดียวกับที่ผู้ใช้ล็อกอินในแอป) แล้วอ่าน
 * "ข้อความที่ผู้ใช้เห็นบนจอ" ตรง ๆ — ได้ค่าเดียวกับหน้าเว็บ ไม่ต้องเดาโครงข้อมูล
 * ข้อแลกเปลี่ยน: หนักกว่า fetch มาก จึงแคช 10 นาทีและกันเปิดซ้อนไว้
 * ตัวแปลงข้อความอยู่ใน liveusage.js (PROVIDERS[id].domParse) เทสต์ได้ด้วย node เปล่า
 */
const DOM_CACHE_MS = 10 * 60 * 1000;
const DOM_TIMEOUT_MS = 40 * 1000; // SPA ของ Google ใช้เวลาหลายวินาทีกว่าจะ render ตัวเลข
const DOM_POLL_MS = 1500;

// รันในหน้าเว็บของเจ้าของ session เอง — อ่านข้อความที่แสดงอยู่เท่านั้น
// ห้ามแตะ cookie/localStorage ห้ามคลิก/กรอก และห้ามส่งอะไรออกจากหน้านั้นเด็ดขาด
const DOM_READ_JS = `(() => (document.body ? document.body.innerText || '' : '').slice(0, 20000))()`;

/** เปิดหน้าเว็บในหน้าต่างที่ซ่อนไว้ อ่านค่า แล้วปิดทิ้งเสมอ — คืน null ถ้าอ่านไม่ได้ */
function readDom(id) {
  const { domUsage: url, domParse } = PROVIDERS[id];
  return new Promise((resolve) => {
    let win = null;
    let timer = null;
    let killer = null;
    let done = false;
    let lastText = ''; // ข้อความล่าสุดที่อ่านได้ — ใช้เป็นหลักฐานตอนแกะไม่ออก
    const finish = (val) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(killer);
      // อ่านไม่ได้เกิดได้หลายสาเหตุที่แยกจากภายนอกไม่ออก (หน้าเปลี่ยนหน้าตา, session หลุด
      // ไปหน้าล็อกอิน, SPA ยัง render ไม่เสร็จ) — ทิ้งข้อความที่เห็นไว้ในเครื่องให้ไล่ดูได้
      if (!val) {
        try {
          fs.writeFileSync(
            path.join(app.getPath('userData'), `debug-dom-${id}.txt`),
            `url: ${url}\nอ่านได้ ${lastText.length} ตัวอักษร\n--- ข้อความบนหน้า ---\n${maskSecrets(lastText).slice(0, 8000)}`,
            'utf8'
          );
        } catch { /* เขียน debug ไม่ได้ ไม่เป็นไร */ }
      }
      // ต้องปิดให้ได้ทุกทาง ไม่งั้นหน้าต่างซ่อนค้างสะสมทุกรอบรีเฟรชจนกินหน่วยความจำ
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch { /* ปิดไปแล้ว */ }
      resolve(val);
    };
    try {
      getSes(id); // ให้ UA ถูกตั้งก่อนหน้าต่างโหลด
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          partition: PROVIDERS[id].partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      win.loadURL(url);
    } catch {
      return finish(null);
    }
    killer = setTimeout(() => finish(null), DOM_TIMEOUT_MS);
    timer = setInterval(async () => {
      try {
        if (!win || win.isDestroyed()) return finish(null);
        const text = await win.webContents.executeJavaScript(DOM_READ_JS, true);
        if (typeof text === 'string' && text) lastText = text;
        const parsed = domParse(text);
        if (parsed) finish(parsed);
      } catch { /* หน้ายังโหลดไม่เสร็จ — รอบหน้าลองใหม่ */ }
    }, DOM_POLL_MS);
  });
}

/** ค่าจากหน้าเว็บพร้อมแคช — คืน { session, weekly } หรือ null */
async function fetchDomUsage(id) {
  if (!PROVIDERS[id].domUsage) return null;
  const s = st(id);
  const now = Date.now();
  if (s.dom.data && now - s.dom.at < DOM_CACHE_MS) return s.dom.data;
  // เปิดหน้าต่างพร้อมกันหลายบานคือหายนะ — รอบที่มาทีหลังเกาะรอบที่กำลังทำอยู่
  if (s.dom.inflight) return s.dom.inflight;
  s.dom.inflight = readDom(id)
    .then((data) => {
      if (data) s.dom = { ...s.dom, at: Date.now(), data };
      return data;
    })
    .finally(() => {
      s.dom.inflight = null;
    });
  return s.dom.inflight;
}

/** คืน { session, weekly } — โยน error พร้อมข้อความไทยเมื่อใช้ไม่ได้ */
async function fetchLive(id) {
  const s = st(id);
  const host = new URL(PROVIDERS[id].home).host;
  const now = Date.now();
  if (now - s.cache.at < CACHE_MS) {
    if (s.cache.error) throw new Error(s.cache.error);
    if (s.cache.data) return s.cache.data;
  }
  if (now < s.backoffUntil) {
    if (s.lastGood.data && now - s.lastGood.at < STALE_MS) return s.lastGood.data;
    throw new Error(s.cache.error || `พักการถาม ${host} ชั่วคราว`);
  }
  try {
    if (!(await hasSession(id))) {
      throw new Error(`ยังไม่ได้ล็อกอิน ${host} — กดปุ่มล็อกอินในหน้าตั้งค่า`);
    }
    // endpoint ที่เรียนรู้จากหน้า usage มาก่อน (ตรงกับที่ผู้ใช้เห็นบนเว็บที่สุด) แล้วค่อย fallback
    const tries = [...(s.discovered ? [s.discovered] : []), ...PROVIDERS[id].fallbackTries];
    if (!tries.length && !PROVIDERS[id].domUsage) {
      throw new Error(`ยังไม่รู้จัก endpoint ของ ${host} — เปิดหน้าต่างล็อกอินแล้วเข้าหน้า usage หนึ่งครั้ง`);
    }
    const out = { session: null, weekly: null };
    let denied = false;
    let lastStatus = 0;
    for (const d of tries) {
      let r;
      try {
        r = await requestOnce(id, d);
      } catch {
        throw new Error('ต่ออินเทอร์เน็ตไม่ได้');
      }
      lastStatus = r.status;
      if (debugSink) {
        debugSink.push(`--- ${d.method} ${d.url}\nstatus ${r.status}\n${(r.text || '').slice(0, 8000)}\n`);
      }
      if (r.status === 401 || r.status === 403) {
        denied = true; // session/token หมดอายุ หรือ Cloudflare ขอยืนยันใหม่
        s.bearer = { at: 0, token: null }; // ให้รอบหน้าขอ token ใหม่
        continue;
      }
      if (r.status === 429) {
        s.backoffUntil = now + BACKOFF_MS;
        break;
      }
      if (r.status !== 200) continue;
      const parsed = parseWebText(r.text, now);
      if (!parsed) continue;
      for (const k of ['session', 'weekly']) {
        if (parsed[k] && (!out[k] || parsed[k].pct > out[k].pct)) out[k] = parsed[k];
      }
    }
    // เจ้าที่ endpoint อ่านไม่ได้ (Gemini) — อ่านจากหน้าเว็บที่ผู้ใช้เห็นเอง
    if (!out.session && !out.weekly && PROVIDERS[id].domUsage) {
      const dom = await fetchDomUsage(id);
      if (debugSink) {
        debugSink.push(`--- อ่านจากหน้าเว็บ ${PROVIDERS[id].domUsage}\n${dom ? JSON.stringify(dom) : 'อ่านไม่ได้'}`);
      }
      if (dom) {
        out.session = dom.session;
        out.weekly = dom.weekly;
      }
    }
    if (!out.session && !out.weekly) {
      if (denied) throw new Error(`${host} ไม่รับ session — เปิดหน้าต่างล็อกอินอีกครั้ง`);
      s.backoffUntil = now + BACKOFF_MS;
      throw new Error(`${host} ไม่ตอบรูปแบบที่รู้จัก (${lastStatus}) — ใช้ค่าปักหมุด/ประมาณแทน`);
    }
    s.cache = { at: now, data: out, error: null };
    s.lastGood = { at: now, data: out };
    return out;
  } catch (err) {
    const msg = String(err.message || err);
    // ค่าดีล่าสุดยังสดพอ → ใช้ต่อ ดีกว่าการ์ดเด้งกลับไปค่าประมาณ
    if (s.lastGood.data && now - s.lastGood.at < STALE_MS) {
      s.cache = { at: now, data: s.lastGood.data, error: null };
      return s.lastGood.data;
    }
    s.cache = { at: now, data: null, error: msg };
    throw err;
  }
}

let debugSink = null;

/** ทดสอบดึงสด ๆ ทันที (ล้าง cache/backoff ก่อน) — ใช้กับปุ่ม "ทดสอบ" ในหน้าตั้งค่า
 * เขียนคำตอบดิบลงไฟล์ debug ใน userData ด้วย (ในเครื่องเท่านั้น ไม่มี cookie/token
 * อยู่ในนั้น) เอาไว้ไล่ดูตอนตัวแกะอ่านค่าออกมาเพี้ยน */
async function testLive(id) {
  const s = st(id);
  s.cache = { at: 0, data: null, error: null };
  s.backoffUntil = 0;
  const endpoint = s.discovered ? s.discovered.url : null;
  debugSink = [];
  let result;
  try {
    const data = await fetchLive(id);
    result = { ok: true, data, endpoint };
  } catch (err) {
    result = { ok: false, error: String(err.message || err), endpoint };
  }
  try {
    debugSink.push(`=== ผลแปลง: ${JSON.stringify(result)}\n`);
    fs.writeFileSync(path.join(app.getPath('userData'), `debug-webquota-${id}.txt`), debugSink.join('\n'), 'utf8');
  } catch { /* เขียน debug ไม่ได้ ไม่เป็นไร */ }
  debugSink = null;
  return result;
}

module.exports = { openLogin, hasSession, logout, fetchLive, testLive, setDiscovered, setOnDiscover };
