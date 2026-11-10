/* ============================================================================
   LE888 Angpao (red packet) gift — set in Admin -> Earn -> Angpao events.
   Logged-in players only. Angpao rain down; tap one -> the big angpao shakes,
   opens, shows the gift -> CLAIM NOW. One claim per player per event (the
   server checks everything again, so it cannot be claimed twice).
   ============================================================================ */
(() => {
  if (window.memberGuest || window.memberImp) return;
  const IMG = { small: '/assets/angpao-small.webp', closed: '/assets/angpao-closed.webp', open: '/assets/angpao-open.webp' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const load = (src) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(true); im.onerror = () => ok(false); im.src = src; });
  let box = null, timer = 0, lastCheck = 0;
  window.leAngpaoBusy = true; // pop-up notices wait until we know

  function finish() {
    clearTimeout(timer);
    if (box) { const b = box; box = null; b.classList.add('ap-out'); setTimeout(() => b.remove(), 260); }
    window.leAngpaoBusy = false;
  }

  function rain(ev) {
    box = document.createElement('div');
    box.className = 'ap-wrap';
    box.innerHTML = '<div class="ap-back"></div>' +
      '<div class="ap-hint"><small>' + esc(String(ev.name).toUpperCase()) + '</small><b>Angpao time!</b><span>Tap an angpao to open</span></div>' +
      '<button type="button" class="ap-later" aria-label="Later">&times;</button>';
    document.body.appendChild(box);
    box.querySelector('.ap-later').onclick = finish;
    let n = 0;
    const W = innerWidth;
    const drop = () => {
      if (!box || box.dataset.open) return;
      const e = document.createElement('button');
      e.type = 'button'; e.className = 'ap-env'; e.setAttribute('aria-label', 'Open angpao');
      const size = 56 + Math.random() * 30;
      e.style.width = size + 'px';
      e.style.left = Math.max(4, Math.random() * (W - size - 8)) + 'px';
      e.style.animationDuration = (reduce() ? 6 : 3.4 + Math.random() * 2.4) + 's';
      e.style.setProperty('--r', (Math.random() * 70 - 35) + 'deg');
      e.innerHTML = '<img src="' + IMG.small + '" alt="" draggable="false" style="animation-duration:' + (0.7 + Math.random() * 0.6) + 's">';
      e.onclick = () => open(ev);
      e.addEventListener('animationend', () => e.remove());
      box.appendChild(e);
      if (n++ % 2 === 0) {
        const k = document.createElement('i'); k.className = 'ap-spark';
        k.style.left = Math.random() * W + 'px'; k.style.animationDuration = (2.6 + Math.random() * 2) + 's';
        k.addEventListener('animationend', () => k.remove()); box.appendChild(k);
      }
      timer = setTimeout(drop, reduce() ? 700 : 280);
    };
    drop();
  }

  function burst(count) {
    for (let i = 0; i < count; i++) {
      const b = document.createElement('i'); b.className = 'ap-burst';
      const a = Math.random() * 6.283, d = 110 + Math.random() * 150;
      b.style.setProperty('--x', Math.cos(a) * d + 'px'); b.style.setProperty('--y', Math.sin(a) * d + 'px');
      b.addEventListener('animationend', () => b.remove()); box.appendChild(b);
    }
  }

  function open(ev) {
    if (!box || box.dataset.open) return;
    box.dataset.open = '1'; clearTimeout(timer);
    box.querySelectorAll('.ap-env,.ap-spark,.ap-hint').forEach((x) => x.remove());
    const unit = ev.gift_type === 'credits' ? 'FREE CREDIT' : 'POINTS';
    const c = document.createElement('div');
    c.className = 'ap-stage';
    c.innerHTML = '<div class="ap-pack"><img class="ap-closed" src="' + IMG.closed + '" alt="Angpao"><img class="ap-open" src="' + IMG.open + '" alt="">' +
      '<div class="ap-gift"><small>YOU GOT</small><b>' + esc(ev.amount_text) + '</b><span>' + unit + '</span></div></div>' +
      '<div class="ap-foot"><div class="ap-title">🎉 Congratulations!</div><p class="ap-sub">' + esc(ev.name) + ' gift from LE888</p>' +
      '<button type="button" class="ap-claim">CLAIM NOW</button><button type="button" class="ap-skip">Later</button></div>';
    box.appendChild(c);
    // shake -> flash + open -> gift rises -> button
    setTimeout(() => { if (!box) return; c.classList.add('ap-opened'); burst(28); }, reduce() ? 50 : 900);
    c.querySelector('.ap-skip').onclick = finish;
    const btn = c.querySelector('.ap-claim');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Claiming…';
      try {
        const r = await memberRequest('angpao/claim', { event_id: ev.id });
        try {
          if (typeof r.points === 'number') memberData.member.points = r.points;
          if (r.reward !== undefined) memberData.member.reward = r.reward;
        } catch (e) { /* ignore */ }
        c.querySelector('.ap-foot').innerHTML = '<div class="ap-done">✅ +' + esc(ev.amount_text) + ' ' + (ev.gift_type === 'credits' ? 'Free Credit' : 'Points') + ' added!</div>' +
          (ev.gift_type === 'credits' ? '<p class="ap-sub">Use it like your other Free Credit (normal rules apply).</p>' : '');
        burst(18);
        setTimeout(() => { finish(); try { if (typeof render === 'function') render(); } catch (e) {} }, 2200);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'CLAIM NOW';
        if (typeof toast === 'function') toast(e && e.message ? e.message : 'Could not claim right now.');
        if (/no longer|already/i.test(String(e && e.message))) setTimeout(finish, 1500);
      }
    };
  }

  async function check() {
    if (box || Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    try {
      const d = await memberRequest('angpao', {});
      const ev = d && d.angpao;
      if (!ev) { window.leAngpaoBusy = false; return; }
      const ok = await load(IMG.small); load(IMG.closed); load(IMG.open);
      if (!ok || box) { window.leAngpaoBusy = false; return; }
      rain(ev);
    } catch (e) { window.leAngpaoBusy = false; }
  }

  setTimeout(check, 700);
  // A new event can start while the app is open / in the background.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 5 * 60e3);
})();
