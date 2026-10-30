/* ============================================================================
   LE888 Pop-up notices (image + button), set in Admin -> Settings -> Pop-up notices.
   - Shows when the app opens (players and guests), one after another.
   - Admin sets "show every X minutes" (e.g. 30). Shows when the app opens, then again
     each time that much time has passed (also while the app stays open).
     A new notice added by admin shows straight away.
   - Remembered on this phone only (if storage is blocked it simply shows each visit).
   ============================================================================ */
(() => {
  const KEY = 'le888_popup_seen';
  const PAGES = ['home', 'promotions', 'vip', 'platforms', 'games', 'deposit', 'deposit-bonus', 'rewards', 'missions', 'invite', 'chat', 'wallet'];
  let showing = false, lastCheck = 0;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  function show(list, roundAt) {
    showing = true;
    let i = 0;
    const box = document.createElement('div');
    box.className = 'pn-wrap';
    box.innerHTML = '<div class="pn-back"></div><section class="pn-card" role="dialog" aria-modal="true" aria-label="Notice">' +
      '<button type="button" class="pn-close" aria-label="Close">&times;</button>' +
      '<div class="pn-img"></div><div class="pn-foot"></div></section>';
    document.body.appendChild(box);
    const seen = readSeen();
    // A full round restarts the clock; a single new notice keeps the old clock.
    const mark = (id) => {
      if (roundAt) { seen.at = roundAt; seen.ids = []; roundAt = 0; }
      seen.ids = seen.ids || [];
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
    if (showing || Date.now() - lastCheck < 50000) return;
    lastCheck = Date.now();
    try {
      const r = await fetch('/api/popups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
      const d = await r.json();
      const popups = (d && d.popups) || [];
      if (!popups.length) return;
      const every = Math.max(15, Number(d.every_min) || 30) * 60e3;
      const seen = readSeen();
      const due = !seen.at || Date.now() - seen.at >= every || seen.at > Date.now();
      const done = due ? [] : (seen.ids || []);
      const todo = [];
      for (const p of popups) {
        if (done.includes(p.id)) continue;
        if (await loadImg(p.image_url)) todo.push(p); // skip broken images
      }
      if (todo.length && !showing) show(todo, due ? Date.now() : 0);
    } catch (e) { /* offline: try next time */ }
  }

  // When the app opens, when it comes back to the front, and every minute while open.
  setTimeout(check, 900);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 60e3);
})();
