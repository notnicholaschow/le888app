/* ============================================================================
   LE888 Guest browsing (visitor is NOT logged in)
   - Open to guests: home, promotions, VIP Club, slot platforms, mini-game list,
     help pages, notifications, Live Chat (guest chat).
   - Anything else (deposit, wallet, rewards, playing a mini game, profile…)
     shows a "Log in / Create account" pop-up. After logging in they come back
     to what they tapped.
   - Nothing here gives access to anything: the server still checks every call.
   ============================================================================ */
(() => {
  if (!window.memberGuest) return;
  const OPEN = new Set(['home', 'games', 'promotions', 'vip', 'platforms', 'terms', 'payment-help', 'reward-help', 'support']);
  const WHAT = {
    deposit: 'make a deposit', withdraw: 'withdraw', wallet: 'open your wallet', rewards: 'claim rewards',
    game: 'play mini games', missions: 'do daily missions', submit: 'submit rewards', history: 'see your history',
    profile: 'see your profile', account: 'see your account', settings: 'change settings', password: 'change your password',
    invite: 'invite friends', 'deposit-bonus': 'claim deposit bonuses', actions: 'use the Action Center', chat: 'chat with us'
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toLogin = (next, signup) => { location.href = '/login' + (next ? '?next=' + encodeURIComponent(next) : '') + (signup ? '#signup' : ''); };

  // Error toasts from blocked guest calls are replaced by the pop-up, so hide them.
  try {
    const plainToast = toast;
    toast = function (t) { if (String(t || '') === window.memberGuestErr) return; return plainToast.apply(this, arguments); };
  } catch (e) { /* no toast */ }

  // ---------- The "please log in" pop-up ----------
  let sheet = null, sheetNext = '';
  function askLogin(page) {
    sheetNext = page && page !== 'home' ? page : (window.state && state.page && state.page !== 'home' ? state.page : '');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.className = 'gm-sheet'; sheet.hidden = true;
      const ic = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      sheet.innerHTML = '<div class="gm-back" data-gm-close></div>' +
        '<section class="gm-card" role="dialog" aria-modal="true" aria-labelledby="gm-title"><div class="gm-card-in">' +
        '<span class="gm-handle" aria-hidden="true"></span><span class="gm-glow" aria-hidden="true"></span>' +
        '<img class="gm-logo" src="/assets/logo888.webp" alt="LE888" onerror="this.remove()">' +
        '<div class="gm-eyebrow"><i></i>MEMBERS\' LOUNGE<i></i></div>' +
        '<h2 id="gm-title">Unlock the full<br>experience</h2><p class="gm-why"></p>' +
        '<ul class="gm-perks">' +
          '<li>' + ic('M4 10h16v10H4zM12 10v10M4 14h16M12 10c-2-4-6-4-6-1.5S10 10 12 10zm0 0c2-4 6-4 6-1.5S14 10 12 10') + '<span>Daily<br>rewards</span></li>' +
          '<li>' + ic('M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5z') + '<span>VIP<br>privileges</span></li>' +
          '<li>' + ic('M5 4h14v16H5zM8 8h8M8 12h8M8 16h5') + '<span>8 slot<br>platforms</span></li>' +
        '</ul>' +
        '<button type="button" class="gm-btn gm-login"><span>LOG IN</span><b aria-hidden="true">→</b></button>' +
        '<button type="button" class="gm-btn gm-join">CREATE A FREE ACCOUNT</button>' +
        '<button type="button" class="gm-later" data-gm-close>Continue browsing</button></div></section>';
      document.body.appendChild(sheet);
      sheet.querySelector('.gm-login').onclick = () => toLogin(sheetNext, false);
      sheet.querySelector('.gm-join').onclick = () => toLogin(sheetNext, true);
      sheet.querySelectorAll('[data-gm-close]').forEach((b) => b.addEventListener('click', () => { sheet.hidden = true; }));
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet && !sheet.hidden) sheet.hidden = true; });
    }
    const what = WHAT[page] || 'continue';
    sheet.querySelector('.gm-why').innerHTML = 'Log in or join free to <b>' + esc(what) + '</b>.';
    sheet.hidden = false;
    setTimeout(() => { try { sheet.querySelector('.gm-login').focus(); } catch (e) {} }, 50);
  }
  window.memberAskLogin = askLogin;

  // ---------- Guest homepage parts ----------
  const JOIN_IMG = '/assets/join-banner.webp';
  let joinImgOk = null;
  (() => { const im = new Image(); im.onload = () => { joinImgOk = true; if (state.page === 'home') decorateHome(); }; im.onerror = () => { joinImgOk = false; }; im.src = JOIN_IMG; })();
  function decorateHome() {
    const strip = document.querySelector('.os-player-strip');
    if (strip && !strip.classList.contains('gm-welcome')) {
      strip.outerHTML = '<section class="os-player-strip gm-welcome"><div class="gm-welcome-copy"><small>WELCOME TO LE888</small><b>Play more together</b><span>Log in to see your points &amp; rewards</span></div>' +
        '<div class="gm-welcome-btns"><button type="button" class="gm-btn gm-login" data-gm-to="login">Log in</button><button type="button" class="gm-btn gm-join" data-gm-to="join">Join now</button></div></section>';
    }
    document.querySelector('.os-points')?.remove();
    const sig = document.querySelector('.os-signature');
    let join = document.querySelector('.gm-joinbanner');
    if (!join && sig) {
      sig.insertAdjacentHTML('beforebegin', '<button type="button" class="gm-joinbanner" data-gm-to="join" aria-label="Join LE888 now"></button>');
      join = document.querySelector('.gm-joinbanner');
    }
    if (join && join.dataset.mode !== String(joinImgOk)) {
      join.dataset.mode = String(joinImgOk);
      join.innerHTML = joinImgOk
        ? '<img src="' + JOIN_IMG + '" alt="Join LE888 now">'
        : '<span class="gm-jb-copy"><small>NEW TO LE888?</small><b>JOIN LE888 NOW</b><span>Free account · Daily check-in rewards · 8 slot platforms</span></span><span class="gm-jb-cta">Create account →</span>';
      join.classList.toggle('gm-has-img', !!joinImgOk);
    }
    document.querySelectorAll('[data-gm-to]').forEach((b) => {
      if (b.dataset.gmWired) return; b.dataset.gmWired = '1';
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toLogin('', b.dataset.gmTo === 'join'); });
    });
  }

  // Side menu: "Log Out" becomes "Log in / Join".
  function patchDrawer() {
    const out = document.querySelector('.drawer-logout');
    if (out && !out.dataset.gm) { out.dataset.gm = '1'; out.innerHTML = '🔑 Log in / Create account'; out.onclick = (e) => { e.preventDefault(); e.stopImmediatePropagation(); toLogin('', false); }; }
    const prof = document.querySelector('#drawer-profile');
    if (prof && !prof.dataset.gm) { prof.dataset.gm = '1'; prof.onclick = (e) => { e.preventDefault(); e.stopImmediatePropagation(); askLogin('profile'); }; }
  }
  new MutationObserver(patchDrawer).observe(document.body, { childList: true, subtree: true });

  // ---------- Page guard ----------
  let last = OPEN.has(state.page) ? state.page : 'home';
  const plainRender = render;
  render = function () {
    const p = state.page || 'home';
    if (p === 'chat' && typeof window.leGuestChatOpen === 'function') {
      state.page = last; history.replaceState(null, '', '#' + last);
      window.leGuestChatOpen('help');
    } else if (!OPEN.has(p)) {
      state.page = last; history.replaceState(null, '', '#' + last);
      askLogin(p);
    } else {
      last = p;
    }
    const out = plainRender.apply(this, arguments);
    if (state.page === 'home') decorateHome();
    patchDrawer();
    return out;
  };
  render();
})();
