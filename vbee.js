// Thay giọng đọc của trình duyệt (speechSynthesis) bằng giọng Vbee qua /api/tts.
// Nếu Vbee lỗi, tự quay về giọng cũ của trình duyệt.
(function () {
  var synth = window.speechSynthesis;
  if (!synth || window.__vbeeOn) return;
  window.__vbeeOn = true;
  var orig = { speak: synth.speak.bind(synth), cancel: synth.cancel.bind(synth), pause: synth.pause.bind(synth), resume: synth.resume.bind(synth) };

  var audio = new Audio();
  var SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  function unlock() { try { audio.src = SILENT; var p = audio.play(); if (p) p.catch(function () {}); } catch (e) {} window.removeEventListener('pointerdown', unlock, true); }
  window.addEventListener('pointerdown', unlock, true);

  var queue = [], current = null, running = false, paused = false, gen = 0;

  function fire(u, type, extra) {
    var ev;
    try {
      ev = type === 'error' ? new SpeechSynthesisErrorEvent('error', Object.assign({ utterance: u }, extra))
                            : new SpeechSynthesisEvent(type, { utterance: u, charIndex: 0, elapsedTime: 0 });
    } catch (e) { ev = new Event(type); }
    try { u.dispatchEvent(ev); } catch (e) {}
  }

  function split(text) {
    var MAX = 280, out = [];
    var parts = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…;:])\s+/);
    var buf = '';
    parts.forEach(function (s) {
      while (s.length > MAX) {
        var cut = s.lastIndexOf(',', MAX); if (cut < 100) cut = s.lastIndexOf(' ', MAX); if (cut < 1) cut = MAX;
        if (buf) { out.push(buf); buf = ''; }
        out.push(s.slice(0, cut + 1).trim()); s = s.slice(cut + 1).trim();
      }
      if ((buf + ' ' + s).trim().length > MAX) { if (buf) out.push(buf); buf = s; }
      else buf = (buf + ' ' + s).trim();
    });
    if (buf) out.push(buf);
    return out.filter(Boolean);
  }

  function fetchAudio(text, rate) {
    return fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, speed: rate, voice: window.VBEE_VOICE }) })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t); }); return r.blob(); })
      .then(function (b) { return URL.createObjectURL(b); });
  }

  function playUrl(url, vol) {
    return new Promise(function (res, rej) {
      audio.onended = function () { res(); };
      audio.onerror = function () { rej(new Error('audio error')); };
      audio.src = url; audio.volume = vol == null ? 1 : vol;
      var p = audio.play(); if (p) p.catch(rej);
    });
  }

  async function playUtt(u, my) {
    var parts = split(u.text || ''), rate = u.rate || 1;
    if (!parts.length) { fire(u, 'end'); return; }
    var next = fetchAudio(parts[0], rate), started = false;
    for (var i = 0; i < parts.length; i++) {
      var url = await next;
      if (i + 1 < parts.length) next = fetchAudio(parts[i + 1], rate);
      if (my !== gen) { URL.revokeObjectURL(url); return; }
      if (!started) { started = true; fire(u, 'start'); }
      try { await playUrl(url, u.volume); } finally { URL.revokeObjectURL(url); }
      if (my !== gen) return;
    }
    fire(u, 'end');
  }

  async function run() {
    if (running) return;
    running = true;
    while (queue.length) {
      var u = queue.shift(), my = gen;
      current = u;
      try { await playUtt(u, my); }
      catch (e) {
        if (my !== gen) break;
        console.warn('[Vbee] lỗi, dùng giọng trình duyệt:', e.message);
        await new Promise(function (res) { u.addEventListener('end', res, { once: true }); u.addEventListener('error', res, { once: true }); orig.speak(u); });
      }
      if (my !== gen) break;
    }
    current = null; running = false;
  }

  synth.speak = function (u) { queue.push(u); run(); };
  synth.cancel = function () {
    gen++;
    var cur = current, q = queue; queue = []; current = null; running = false; paused = false;
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) {}
    orig.cancel();
    if (cur) fire(cur, 'error', { error: 'interrupted' });
    q.forEach(function (u) { fire(u, 'error', { error: 'canceled' }); });
  };
  synth.pause = function () { paused = true; try { audio.pause(); } catch (e) {} orig.pause(); };
  synth.resume = function () { paused = false; try { if (audio.src && audio.paused && !audio.ended) audio.play(); } catch (e) {} orig.resume(); };
  try {
    Object.defineProperty(synth, 'speaking', { configurable: true, get: function () { return !!current; } });
    Object.defineProperty(synth, 'pending', { configurable: true, get: function () { return queue.length > 0; } });
    Object.defineProperty(synth, 'paused', { configurable: true, get: function () { return paused; } });
  } catch (e) {}
  console.log('[Vbee] đã bật giọng Vbee');
})();
