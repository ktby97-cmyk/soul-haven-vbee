/* Soul Haven – giọng đọc Vbee chỉ cho LỜI DẪN trong khung hình.
   - Bấm vào mục nào (Tiếp, Đóm, một phòng, một vật trong cảnh...) thì đọc lời dẫn mới hiện ra.
   - Nút Nghe: đọc lời dẫn đang hiện trong khung hình; bấm lần nữa để dừng.
   Không đọc chữ bên ngoài khung hình. */
(function () {
  if (window.__shVoice) return; window.__shVoice = true;
  var app = document.getElementById('app'); if (!app) return;
  var audio = new Audio(), cache = new Map(), playId = 0, playing = false, last = [], armedUntil = 0, timer = 0, sceneClick = false;

  function btn() { return document.getElementById('tts-btn'); }
  function setBtn(on) {
    playing = on; var b = btn(); if (!b) return;
    b.classList.toggle('on', on); var s = b.querySelector('span'); if (s) s.textContent = on ? 'Dừng' : 'Nghe';
  }
  function say(msg) { try { if (typeof toast === 'function') toast(msg, false); } catch (e) {} }

  /* Lời dẫn = chữ HTML hiển thị bên trong khung hình (.scene) + bong bóng của Đóm; bỏ nút bấm và chữ trong hình vẽ */
  function visible(el) { if (el.closest('[hidden]')) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function collect(withToast) {
    var out = [];
    /* bấm vào một vật trong khung hình: lời nhắn hiện ra ngay dưới khung (toast) cũng được đọc */
    var tst = document.getElementById('toast');
    if (withToast && tst && tst.classList.contains('show')) { var tt = (tst.innerText || '').replace(/\s+/g, ' ').trim(); if (tt.length > 1) out.push({ el: tst, t: tt }); }
    app.querySelectorAll('.scene, #fox-bubble').forEach(function (root) {
      var nodes = root.id === 'fox-bubble' ? [root] : root.querySelectorAll('p, b, strong, span, div, h2, h3, h4, li');
      nodes.forEach(function (el) {
        if (el.closest('svg, button, .btn, .btn-mini, input, textarea, select, label')) return;
        if (!el.id || el.id !== 'fox-bubble') {
          var own = false; for (var i = 0; i < el.childNodes.length; i++) { var c = el.childNodes[i]; if (c.nodeType === 3 && c.textContent.trim()) { own = true; break; } }
          if (!own) return;
          if (el.parentElement && el.parentElement.closest('.scene') && out.some(function (o) { return o.el.contains(el); })) return;
        }
        if (!visible(el)) return;
        var t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > 1) out.push({ el: el, t: t });
      });
    });
    var seen = new Set(), res = [];
    out.forEach(function (o) { if (!seen.has(o.t)) { seen.add(o.t); res.push(o.t); } });
    return res;
  }
  function tidy(list) { return list.map(function (s) { s = s.replace(/,(?=\S)/g, '. '); return /[.!?…:]$/.test(s) ? s : s + '.'; }).join(' '); }

  function stop() { playId++; try { audio.pause(); } catch (e) {} setBtn(false); }
  function getUrl(text) {
    if (cache.has(text)) return Promise.resolve(cache.get(text));
    return fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) })
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error((j.error && j.error.message) || ('Lỗi máy chủ (HTTP ' + r.status + ')')); });
        return r.blob();
      })
      .then(function (b) { var u = URL.createObjectURL(b); cache.set(text, u); return u; });
  }
  function speak(text) {
    if (!text) return;
    var id = ++playId; try { audio.pause(); } catch (e) {} setBtn(true);
    getUrl(text).then(function (u) {
      if (id !== playId) return;
      audio.src = u; audio.onended = function () { if (id === playId) setBtn(false); };
      var p = audio.play(); if (p) p.catch(function (e) { if (id === playId) { setBtn(false); if (e && e.name === 'NotAllowedError') say('Trình duyệt chặn tự phát, hãy bấm Nghe.'); } });
    }).catch(function (e) { if (id === playId) { setBtn(false); say(e.message); } });
  }

  /* Nút Nghe: chỉ đọc lời dẫn đang có trong khung hình */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#tts-btn'); if (!b) return;
    e.stopImmediatePropagation(); e.preventDefault();
    try { speechSynthesis.cancel(); } catch (x) {}
    if (playing) { stop(); return; }
    var list = collect(); last = list;
    if (!list.length) { say('Khung hình này chưa có lời dẫn. Bấm vào một mục để nghe.'); return; }
    speak(tidy(list));
  }, true);

  /* Bấm vào mục nào: đọc lời dẫn MỚI hiện ra sau cú bấm đó */
  function check() {
    var now = collect(sceneClick), fresh = now.filter(function (t) { return last.indexOf(t) < 0; });
    last = now;
    if (fresh.length) speak(tidy(fresh));
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('#tts-btn, #tts-gear, #tts-pn')) return;
    try { if (!audio.src) { audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='; var p = audio.play(); if (p) p.catch(function () {}); } } catch (x) {}
    sceneClick = !!(e.target.closest && e.target.closest('.scene'));
    last = collect(sceneClick); armedUntil = Date.now() + 4000;
  }, true);
  new MutationObserver(function () {
    if (Date.now() > armedUntil) return;
    clearTimeout(timer); timer = setTimeout(check, 450);
  }).observe(app, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
  var tEl = document.getElementById('toast'); if (tEl) new MutationObserver(function () { if (Date.now() <= armedUntil) { clearTimeout(timer); timer = setTimeout(check, 450); } }).observe(tEl, { subtree: true, childList: true, characterData: true, attributes: true });

  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); });
  console.log('[Soul Haven] Giọng đọc: chỉ lời dẫn trong khung hình');
})();
