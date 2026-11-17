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
  const voice = String(body.voice || '').trim() || VOICE;
  try {
    const parts = split(text), bufs = [];
    for (const p of parts) bufs.push(await vbee(p, voice)); // đọc lần lượt, nối các đoạn mp3
    const all = Buffer.concat(bufs);
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
  try { await vbee('Xin chào.', code); json(res, 200, { supported: true, voice: { code, name: code } }); }
  catch (e) { json(res, 200, { supported: false, error: { code: e.code || 'server', message: e.message } }); }
}

// ---------- trang app ----------
function findHtml() {
  if (fs.existsSync(path.join(DIR, 'index.html'))) return path.join(DIR, 'index.html');
  const f = fs.readdirSync(DIR).find(n => n.toLowerCase().endsWith('.html'));
  return f ? path.join(DIR, f) : null;
}
// Gắn vào đầu trang: báo app đang chạy trên máy chủ này, và lần đầu mở thì bật sẵn Vbee + mã giọng mặc định.
const BOOT = `<script>window.SOULHAVEN_TTS_BASE='';try{var k='soulHaven.tts',c=JSON.parse(localStorage.getItem(k)||'{}');if(!c._srv){c.mode='vbee';c._srv=1;}if(!c.voice)c.voice=${JSON.stringify(VOICE)};localStorage.setItem(k,JSON.stringify(c));}catch(e){}</script>`;

function serveApp(res) {
  const f = findHtml();
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Chưa có file index.html trong kho GitHub.'); }
  let html = fs.readFileSync(f, 'utf8');
  const i = html.search(/<head[^>]*>/i);
  html = i >= 0 ? html.replace(/<head[^>]*>/i, m => m + BOOT) : BOOT + html;
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
  if (url === '/health') return json(res, 200, { ok: true, vbee: !!(APP_ID && TOKEN), voice: VOICE });
  serveStatic(req, res);
}).listen(PORT, () => console.log('Soul Haven chạy ở cổng ' + PORT));
