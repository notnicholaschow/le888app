/* ============================================================================
   LE888 Pop-up notices (image + button), set in Admin -> Settings -> Pop-up notices.
   - Shows when the app opens (players and guests), one after another.
   - Admin sets fixed times (Singapore time), e.g. 12:00, 18:00, 21:00.
     After each time passes, the notices show again ONCE the next time the app is opened.
     No times set = once a day.
   - Remembered on this phone only (if storage is blocked it simply shows each visit).
   ============================================================================ */
(() => {
  const KEY = 'le888_popup_seen';
  const PAGES = ['home', 'promotions', 'vip', 'platforms', 'games', 'deposit', 'deposit-bonus', 'rewards', 'missions', 'invite', 'chat', 'wallet'];
  let showing = false, lastCheck = 0;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The current "time slot" in Singapore time, e.g. "2026-10-30@18:00".
  function slotKey(times) {
    const sg = new Date(Date.now() + 8 * 3600e3);
    const day = sg.toISOString().slice(0, 10), hm = sg.toISOString().slice(11, 16);
    if (!times.length) return day;
    let last = '';
    times.forEach((t) => { if (t <= hm) last = t; });
    if (last) return day + '@' + last;
    return new Date(sg.getTime() - 86400e3).toISOString().slice(0, 10) + '@' + times[times.length - 1];
  }
  const readSeen = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } };
  const writeSeen = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode */ } };

  function loadImg(src) {
    return new Promise((ok) => { const im = new Image(); im.onload = () => ok(true); im.onerror = () => ok(false); im.src = src; });
  }

  function openLink(link) {
    if (!link) return;
    const m = /^app:([a-z-]{2,20})$/.exec(link);
    if (m) { if (PAGES.includes(m[1]) && typeof go === 'function') go(m[1]); return; }
    if (/^https:\/\//i.test(link)) window.open(link, '_blank', 'noopener');
  }

  function show(list, slot) {
    showing = true;
    let i = 0;
    const box = document.createElement('div');
    box.className = 'pn-wrap';
    box.innerHTML = '<div class="pn-back"></div><section class="pn-card" role="dialog" aria-modal="true" aria-label="Notice">' +
      '<button type="button" class="pn-close" aria-label="Close">&times;</button>' +
      '<div class="pn-img"></div><div class="pn-foot"></div></section>';
    document.body.appendChild(box);
    const seen = readSeen();
    const mark = (id) => {
      if (seen.slot !== slot) { seen.slot = slot; seen.ids = []; }
      if (!seen.ids.includes(id)) seen.ids.push(id);
      writeSeen(seen);
    };
    const close = () => {
      box.classList.add('pn-out');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { box.remove(); showing = false; }, 220);
    };
    const next = () => { i++; if (i >= list.length) close(); else draw(); };
    const onKey = (e) => { if (e.key === 'Escape') next(); };
    document.addEventListener('keydown', onKey);
    function draw() {
      const p = list[i];
      mark(p.id);
      const card = box.querySelector('.pn-card');
      card.classList.remove('pn-in'); void card.offsetWidth; card.classList.add('pn-in');
      const tap = p.button_link ? ' pn-tap' : '';
      box.querySelector('.pn-img').innerHTML = '<img class="' + tap + '" src="' + esc(p.image_url) + '" alt="Notice">';
      box.querySelector('.pn-foot').innerHTML =
        (p.button_text && p.button_link ? '<button type="button" class="pn-btn">' + esc(p.button_text) + '</button>' : '') +
        (list.length > 1 ? '<div class="pn-count">' + list.map((x, k) => '<i' + (k === i ? ' class="on"' : '') + '></i>').join('') + '</div>' : '');
      const act = () => { close(); openLink(p.button_link); };
      const b = box.querySelector('.pn-btn'); if (b) b.onclick = act;
      if (p.button_link) box.querySelector('.pn-img img').onclick = act;
      setTimeout(() => { try { box.querySelector('.pn-close').focus({ preventScroll: true }); } catch (e) {} }, 60);
    }
    box.querySelector('.pn-close').onclick = next;
    box.querySelector('.pn-back').onclick = next;
    draw();
  }

  async function check() {
    if (showing || Date.now() - lastCheck < 20000) return;
    lastCheck = Date.now();
    try {
      const r = await fetch('/api/popups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
      const d = await r.json();
      const popups = (d && d.popups) || [];
      if (!popups.length) return;
      const slot = slotKey((d.times || []).slice().sort());
      const seen = readSeen();
      const done = seen.slot === slot ? (seen.ids || []) : [];
      const todo = [];
      for (const p of popups) {
        if (done.includes(p.id)) continue;
        if (await loadImg(p.image_url)) todo.push(p); // skip broken images
      }
      if (todo.length && !showing) show(todo, slot);
    } catch (e) { /* offline: try next time */ }
  }

  // When the app opens, when it comes back to the front, and every few minutes while open.
  setTimeout(check, 900);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 5 * 60e3);
})();
