// Máy chủ Soul Haven + Vbee: phục vụ app và đọc bằng giọng Vbee.
// Token Vbee chỉ nằm ở biến môi trường trên Render, không bao giờ gửi xuống app.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APP_ID = (process.env.VBEE_APP_ID || '').trim();
const TOKEN = (process.env.VBEE_TOKEN || '').trim();
const VOICE = (process.env.VBEE_VOICE || 'hn_female_ngochuyen_full_48k-fhg').trim();
const DIR = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };

// ---------- tiện ích ----------
const hits = new Map();
function tooMany(ip) { // tối đa 40 lượt / phút / IP để không bị người lạ tiêu credit
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(ip, h);
  return h.length > 40;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 50000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
const fail = (res, http, code, message) => json(res, http, { error: { code, message } });

// cắt chữ thành đoạn ≤ 280 ký tự (Vbee nhận tối đa 300)
function split(text, MAX = 280) {
  const out = []; let buf = '';
  for (let s of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…;:])\s+/)) {
    while (s.length > MAX) {
      let cut = s.lastIndexOf(',', MAX); if (cut < 80) cut = s.lastIndexOf(' ', MAX); if (cut < 1) cut = MAX;
      if (buf) { out.push(buf); buf = ''; }
      out.push(s.slice(0, cut + 1).trim()); s = s.slice(cut + 1).trim();
    }
    if (!s) continue;
    if ((buf + ' ' + s).trim().length > MAX) { if (buf) out.push(buf); buf = s; } else buf = (buf + ' ' + s).trim();
  }
  if (buf) out.push(buf);
  return out;
}

class VbeeError extends Error { constructor(http, code, message) { super(message); this.http = http; this.code = code; } }

async function vbee(text, voice) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
  let r;
  try {
    r = await fetch('https://api.vbee.vn/v1/tts', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, 'App-Id': APP_ID },
      body: JSON.stringify({ text, voiceCode: voice, outputFormat: 'mp3', bitrate: 128, speed: 1.0, mode: 'sync' })
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new VbeeError(504, 'timeout', 'Vbee quá lâu không trả lời, thử lại sau.');
    throw new VbeeError(502, 'network', 'Máy chủ không tới được Vbee (' + e.message + ').');
  }
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || ct.includes('json')) {
    const raw = await r.text().catch(() => ''); clearTimeout(timer);
    let msg = raw; try { const j = JSON.parse(raw); msg = (j.error && (j.error.message || j.error.code)) || j.message || raw; } catch (e) {}
    console.error('Vbee', r.status, raw);
    if (r.status === 401 || r.status === 403) throw new VbeeError(401, 'auth', 'Lỗi xác thực Vbee: App ID hoặc Token trên Render chưa đúng.');
    if (r.status === 429) throw new VbeeError(429, 'busy', 'Vbee đang bận, thử lại sau ít giây.');
    if (/credit|balance|số dư/i.test(msg)) throw new VbeeError(402, 'credit', 'Vbee hết credit.');
    if (/voice/i.test(msg)) throw new VbeeError(400, 'voice', 'Lỗi mã giọng Vbee: ' + msg);
    throw new VbeeError(502, 'vbee', 'Vbee báo lỗi (HTTP ' + r.status + '): ' + String(msg).slice(0, 200));
  }
  const buf = Buffer.from(await r.arrayBuffer()); clearTimeout(timer);
  return buf;
}

// Batch API (mode async): dùng cho giọng không có trong Realtime API, ví dụ giọng quảng cáo.
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const batchVoices = new Set(); // giọng đã biết chỉ chạy được bằng Batch API
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function vbeeCall(url, opts) {
  try { return await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, opts)); }
  catch (e) { throw new VbeeError(502, 'network', 'Máy chủ không tới được Vbee (' + e.message + ').'); }
}
async function vbeeErr(r) {
  const raw = await r.text().catch(() => '');
  let msg = raw; try { const j = JSON.parse(raw); msg = (j.error && (j.error.message || j.error.code)) || j.message || raw; } catch (e) {}
  console.error('Vbee batch', r.status, raw);
  if (r.status === 401 || r.status === 403) return new VbeeError(401, 'auth', 'Lỗi xác thực Vbee: App ID hoặc Token trên Render chưa đúng.');
  if (/credit|balance|số dư/i.test(msg)) return new VbeeError(402, 'credit', 'Vbee hết credit.');
  if (/voice/i.test(msg)) return new VbeeError(400, 'voice', 'Lỗi mã giọng Vbee: ' + msg);
  return new VbeeError(502, 'vbee', 'Vbee báo lỗi (HTTP ' + r.status + '): ' + String(msg).slice(0, 200));
}
async function vbeeBatch(text, voice, host) {
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, 'App-Id': APP_ID };
  const hook = (BASE_URL || 'https://' + host) + '/api/vbee-hook';
  const r = await vbeeCall('https://api.vbee.vn/v1/tts', { method: 'POST', headers: H, body: JSON.stringify({ text, voiceCode: voice, outputFormat: 'mp3', bitrate: 128, speed: 1.0, mode: 'async', webhookUrl: hook }) });
  if (!r.ok) throw await vbeeErr(r);
  const { requestId } = await r.json();
  if (!requestId) throw new VbeeError(502, 'vbee', 'Vbee không trả mã yêu cầu.');
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(Date.now() - t0 < 5000 ? 600 : 1500);
    const g = await vbeeCall('https://api.vbee.vn/v1/tts/requests/' + encodeURIComponent(requestId), { headers: H });
    if (!g.ok) throw await vbeeErr(g);
    const j = await g.json();
    if (j.status === 'COMPLETED' && j.audioLink) {
      const a = await vbeeCall(j.audioLink, {});
      if (!a.ok) throw new VbeeError(502, 'vbee', 'Không tải được âm thanh từ Vbee (HTTP ' + a.status + ').');
      return Buffer.from(await a.arrayBuffer());
    }
    if (j.status === 'FAILED' || j.error) throw new VbeeError(502, 'vbee', 'Vbee đọc thất bại: ' + (j.error_message || (j.error && j.error.message) || 'không rõ lý do'));
  }
  throw new VbeeError(504, 'timeout', 'Vbee quá lâu không trả lời, thử lại sau.');
}
// Thử Realtime (nhanh); nếu giọng không có trong Realtime thì chuyển sang Batch.
async function speakAll(text, voice, host) {
  if (!batchVoices.has(voice)) {
    try {
      const bufs = [];
      for (const p of split(text)) bufs.push(await vbee(p, voice));
      return Buffer.concat(bufs);
    } catch (e) {
      if (!(e instanceof VbeeError) || e.code !== 'voice') throw e;
      console.log('Giọng ' + voice + ' không có trong Realtime, chuyển sang Batch API');
      batchVoices.add(voice);
    }
  }
  return vbeeBatch(text, voice, host);
}

function guard(req, res) {
  if (!APP_ID || !TOKEN) { fail(res, 500, 'config', 'Máy chủ chưa cấu hình: thiếu VBEE_APP_ID hoặc VBEE_TOKEN trên Render.'); return false; }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (tooMany(ip)) { fail(res, 429, 'busy', 'Quá nhiều lượt đọc, chờ một phút rồi thử lại.'); return false; }
  return true;
}

// ---------- API ----------
async function apiTts(req, res) {
  if (!guard(req, res)) return;
  let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return fail(res, 400, 'bad', 'Dữ liệu gửi lên không hợp lệ.'); }
  const text = String(body.text || '').slice(0, 3000).trim();
  if (!text) return fail(res, 400, 'bad', 'Không có nội dung để đọc.');
  const voice = VOICE; // luôn dùng giọng cài trên Render (VBEE_VOICE), bỏ qua giọng cũ còn lưu trong trình duyệt
  try {
    const all = await speakAll(text, voice, req.headers.host);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': all.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(all);
  } catch (e) {
    if (e instanceof VbeeError) return fail(res, e.http, e.code, e.message);
    console.error(e); fail(res, 500, 'server', 'Lỗi máy chủ: ' + e.message);
  }
}

async function apiVoices(req, res) {
  const code = (new URL(req.url, 'http://x').searchParams.get('code') || '').trim();
  if (!code) return json(res, 400, { supported: false, error: { code: 'voice', message: 'Chưa nhập mã giọng.' } });
  if (!guard(req, res)) return;
  try { await speakAll('Xin chào.', code, req.headers.host); json(res, 200, { supported: true, voice: { code, name: code }, mode: batchVoices.has(code) ? 'batch' : 'realtime' }); }
  catch (e) { json(res, 200, { supported: false, error: { code: e.code || 'server', message: e.message } }); }
}

// Danh sách giọng trên tài khoản Vbee: /api/voice-list?q=vy
async function apiVoiceList(req, res) {
  if (!guard(req, res)) return;
  const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').toLowerCase();
  const H = { Authorization: 'Bearer ' + TOKEN, 'App-Id': APP_ID, 'Content-Type': 'application/json' };
  const out = [];
  for (const own of ['VBEE', 'COMMUNITY', 'PERSONAL']) { let cursor = '';
  for (let i = 0; i < 15; i++) {
    const r = await vbeeCall('https://vbee.vn/api/public/v1/voices?limit=100&languageCode=vi-VN&voiceOwnership=' + own + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { headers: H });
    if (!r.ok) { if (own === 'VBEE') return fail(res, r.status, 'vbee', 'Không lấy được danh sách giọng (HTTP ' + r.status + '): ' + (await r.text()).slice(0, 300)); break; }
    const j = await r.json(), R = j.result || {};
    for (const v of R.voices || []) if (!q || (v.code + ' ' + v.name).toLowerCase().includes(q)) out.push({ code: v.code, name: v.name, gender: v.gender, own });
    if (!R.pagination || !R.pagination.has_next_page) break;
    cursor = R.pagination.next_cursor;
  } }
  json(res, 200, { count: out.length, voices: out });
}

// ---------- trang app ----------
function findHtml() {
  if (fs.existsSync(path.join(DIR, 'index.html'))) return path.join(DIR, 'index.html');
  const f = fs.readdirSync(DIR).find(n => n.toLowerCase().endsWith('.html'));
  return f ? path.join(DIR, f) : null;
}
// Gắn vào đầu trang: báo app đang chạy trên máy chủ này, và lần đầu mở thì bật sẵn Vbee + mã giọng mặc định.
const BOOT = `<script>window.SOULHAVEN_TTS_BASE='';try{var k='soulHaven.tts',c=JSON.parse(localStorage.getItem(k)||'{}');if(!c._srv){c.mode='vbee';}var V=${JSON.stringify(VOICE)};c.voice=V;c.mode='vbee';c._sv=V;c._srv=1;localStorage.setItem(k,JSON.stringify(c));}catch(e){}</script>`;

function serveApp(res) {
  const f = findHtml();
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Chưa có file index.html trong kho GitHub.'); }
  let html = fs.readFileSync(f, 'utf8');
  const i = html.search(/<head[^>]*>/i);
  html = i >= 0 ? html.replace(/<head[^>]*>/i, m => m + BOOT) : BOOT + html;
  // Gắn sh-voice.js (chỉ đọc lời dẫn trong khung hình) vào cuối trang
  const vf = path.join(DIR, 'sh-voice.js');
  if (fs.existsSync(vf)) {
    const tag = '<script>' + fs.readFileSync(vf, 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>';
    const j = html.lastIndexOf('</body>');
    html = j >= 0 ? html.slice(0, j) + tag + html.slice(j) : html + tag;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function serveStatic(req, res) {
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/' || p === '/index.html') return serveApp(res);
  const file = path.normalize(path.join(DIR, p)), ext = path.extname(file).toLowerCase();
  if (!file.startsWith(DIR + path.sep) || !TYPES[ext] || ext === '.html') { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[ext] }); res.end(data);
  });
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  const done = p => p.catch(e => { console.error(e); if (!res.headersSent) fail(res, 500, 'server', 'Lỗi máy chủ.'); });
  if (url === '/api/tts' && req.method === 'POST') return done(apiTts(req, res));
  if (url === '/api/voices') return done(apiVoices(req, res));
  if (url === '/api/vbee-hook') { readBody(req).then(b => console.log('Vbee hook', b.slice(0, 300))).catch(() => {}); return json(res, 200, { ok: true }); }
  if (url === '/api/voice-list') return done(apiVoiceList(req, res));
  if (url === '/health') return json(res, 200, { ok: true, vbee: !!(APP_ID && TOKEN), voice: VOICE });
  serveStatic(req, res);
}).listen(PORT, () => console.log('Soul Haven chạy ở cổng ' + PORT));
