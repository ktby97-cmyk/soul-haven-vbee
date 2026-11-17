// Soul Haven + Vbee: phục vụ app và chuyển lời đọc sang Vbee (giữ token ở server)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APP_ID = process.env.VBEE_APP_ID;
const TOKEN = process.env.VBEE_TOKEN;
const VOICE = process.env.VBEE_VOICE || 'hn_female_ngochuyen_full_48k-fhg';
const PUB = __dirname; // mọi file nằm cùng một chỗ, cho dễ tải lên GitHub
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };

// giới hạn đơn giản: tối đa 60 lượt đọc / phút / IP
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(ip, h);
  return h.length > 60;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 20000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function tts(req, res) {
  if (!APP_ID || !TOKEN) return json(res, 500, { error: 'Chưa cài VBEE_APP_ID và VBEE_TOKEN trên Render' });
  const origin = req.headers.origin || req.headers.referer || '';
  if (origin && !origin.includes(req.headers.host)) return json(res, 403, { error: 'forbidden' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (tooMany(ip)) return json(res, 429, { error: 'Quá nhiều yêu cầu' });

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
  const text = String(body.text || '').trim().slice(0, 300);
  if (!text) return json(res, 400, { error: 'empty text' });
  const speed = Math.min(1.9, Math.max(0.25, Number(body.speed) || 1));

  const r = await fetch('https://api.vbee.vn/v1/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, 'App-Id': APP_ID },
    body: JSON.stringify({ text, voiceCode: body.voice || VOICE, outputFormat: 'mp3', bitrate: 128, speed, mode: 'sync' })
  });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || ct.includes('json')) {
    const t = await r.text();
    console.error('Vbee error', r.status, t);
    res.writeHead(r.ok ? 502 : r.status, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(t);
  }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  const ext0 = path.extname(file).toLowerCase();
  const okFile = path.basename(file) === 'vbee.js' || !['.js', '.json', '.md', ''].includes(ext0);
  if (!file.startsWith(PUB) || !okFile) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') {
      // tự gắn vbee.js vào trang, không cần sửa index.html
      let html = data.toString('utf8');
      const tag = '<script src="/vbee.js"></script>';
      const i = html.lastIndexOf('</body>');
      html = i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
      data = Buffer.from(html, 'utf8');
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/tts')) {
    return tts(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end(); });
  }
  if (req.url === '/health') return json(res, 200, { ok: true, vbee: !!(APP_ID && TOKEN) });
  serveStatic(req, res);
}).listen(PORT, () => console.log('Soul Haven chạy ở cổng ' + PORT));
