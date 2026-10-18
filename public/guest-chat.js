/* ============================================================================
   LE888 Guest Live Chat (login page — no account needed)
   - A floating "Live Chat" button. The guest types name + phone, then chats.
   - Staff see it in Admin -> Messages with a blue GUEST label.
   - This phone/browser remembers the chat (a private random key), so closing
     the page and coming back later shows the same conversation.
   - Text only. Switch on/off in Admin -> Settings.
   ============================================================================ */
(function () {
  'use strict';
  var KEY = 'le888_guest_chat', SEEN = 'le888_guest_seen';
  var API = '/api/member/guest-chat/';
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  var saved = null; try { saved = JSON.parse(load(KEY) || 'null'); } catch (e) { saved = null; }
  var token = saved && saved.t ? String(saved.t) : '';
  var gname = saved && saved.n ? String(saved.n) : '';
  var msgs = [], lastId = 0, isOpen = false, timer = null, sending = false, linked = false;
  var seenId = Number(load(SEEN) || 0) || 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function linkify(t) { return esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>'); }
  function timeOf(s) {
    var v = String(s || ''); if (v && v.indexOf('T') === -1) v = v.replace(' ', 'T') + 'Z';
    var d = new Date(v); if (isNaN(d)) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  // Staff template messages are HTML: keep safe formatting only.
  function clean(raw) {
    var OK = { A:1,B:1,STRONG:1,I:1,EM:1,U:1,S:1,BR:1,P:1,DIV:1,SPAN:1,IMG:1,UL:1,OL:1,LI:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,TABLE:1,THEAD:1,TBODY:1,TR:1,TD:1,TH:1,HR:1,SMALL:1,CENTER:1,BLOCKQUOTE:1,FONT:1,MARK:1,SUB:1,SUP:1 };
    var AT = { style:1,href:1,src:1,alt:1,title:1,width:1,height:1,colspan:1,rowspan:1,align:1,valign:1,color:1,size:1,border:1,cellpadding:1,cellspacing:1,bgcolor:1 };
    var doc; try { doc = new DOMParser().parseFromString('<body>' + String(raw || '') + '</body>', 'text/html'); } catch (e) { return ''; }
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (c) {
        if (c.nodeType === 8) { c.remove(); return; }
        if (c.nodeType !== 1) return;
        var tag = c.tagName.toUpperCase();
        if (!OK[tag]) { if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|FORM|INPUT|BUTTON|SVG|BASE|TEMPLATE)$/.test(tag)) { c.remove(); return; } walk(c); while (c.firstChild) node.insertBefore(c.firstChild, c); c.remove(); return; }
        Array.prototype.slice.call(c.attributes).forEach(function (a) {
          var n = a.name.toLowerCase(), v = String(a.value || '').trim().toLowerCase();
          if (!AT[n]) { c.removeAttribute(a.name); return; }
          if ((n === 'href' || n === 'src') && !(/^(https?:\/\/|\/api\/chat\/img\/|\/img\/|data:image\/|mailto:|tel:)/.test(v)) ) c.removeAttribute(a.name);
          if (n === 'style' && /expression|javascript:|@import|url\s*\(/i.test(v)) c.removeAttribute(a.name);
        });
        if (tag === 'A') { c.setAttribute('target', '_blank'); c.setAttribute('rel', 'noopener noreferrer'); }
        walk(c);
      });
    })(doc.body);
    return doc.body.innerHTML;
  }

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-LE888-Guest': token || '' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; }); });
  }

  // ---------- Build the button + window ----------
  var fab = document.createElement('button');
  fab.type = 'button'; fab.className = 'gc-fab'; fab.hidden = true;
  fab.setAttribute('aria-label', 'Open Live Chat');
  fab.innerHTML = '<span class="gc-fab-ic" aria-hidden="true">💬</span><b>Live Chat</b><span class="gc-dot" hidden></span>';
  var wrap = document.createElement('div');
  wrap.className = 'gc-wrap'; wrap.hidden = true;
  wrap.innerHTML =
    '<div class="gc-back" data-gc-close></div>' +
    '<section class="gc-panel" role="dialog" aria-modal="true" aria-label="Live Chat">' +
      '<header class="gc-head"><span class="gc-avatar" aria-hidden="true">💬</span><div><b>Live Chat</b><small>LE888 customer service</small></div>' +
      '<button type="button" class="gc-x" data-gc-close aria-label="Close">&times;</button></header>' +
      '<div class="gc-start" hidden>' +
        '<p class="gc-lead"></p>' +
        '<div class="gc-pick" role="radiogroup" aria-label="Who are you?">' +
          '<button type="button" role="radio" data-who="old"><span aria-hidden="true">👤</span><b>I\'m an existing LE888 player</b><small>I have a Player ID</small></button>' +
          '<button type="button" role="radio" data-who="new"><span aria-hidden="true">✨</span><b>I\'m a new player</b><small>No account yet</small></button>' +
        '</div>' +
        '<div class="gc-fields" hidden>' +
          '<label for="gc-name">Full name <span class="gc-hint gc-name-hint">(as registered in LE888)</span></label><input id="gc-name" maxlength="60" autocomplete="name" placeholder="e.g. Tan Ah Kow">' +
          '<div class="gc-f-id"><label for="gc-pid">Your LE888 Player ID</label>' +
          '<input id="gc-pid" maxlength="32" autocapitalize="characters" autocomplete="username" spellcheck="false" placeholder="e.g. LE10695"></div>' +
          '<div class="gc-f-phone" hidden><label for="gc-phone">Phone number <span class="gc-hint">(start with 65, no + needed)</span></label>' +
          '<input id="gc-phone" type="tel" inputmode="numeric" maxlength="20" autocomplete="tel" placeholder="e.g. 6591234567"></div>' +
          '<p class="gc-err" role="alert"></p>' +
          '<button type="button" class="gc-go">Start chat <span aria-hidden="true">→</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="gc-chat" hidden>' +
        '<div class="gc-list" aria-live="polite"></div>' +
        '<p class="gc-err gc-send-err" role="alert"></p>' +
        '<div class="gc-compose"><textarea rows="1" maxlength="1000" placeholder="Type your message…" aria-label="Message"></textarea>' +
        '<button type="button" class="gc-send" aria-label="Send">Send</button></div>' +
      '</div>' +
      '<div class="gc-linked" hidden><p>Your chat has been moved to your account.</p><p class="gc-sub">Please log in to continue chatting with us.</p>' +
        '<button type="button" class="gc-go" data-gc-close>OK, log in</button></div>' +
    '</section>';
  document.body.appendChild(fab);
  document.body.appendChild(wrap);
  var $ = function (s) { return wrap.querySelector(s); };
  var startEl = $('.gc-start'), chatEl = $('.gc-chat'), linkedEl = $('.gc-linked'), listEl = $('.gc-list');
  var ta = $('.gc-compose textarea'), sendBtn = $('.gc-send'), dot = fab.querySelector('.gc-dot');

  function view(which) {
    startEl.hidden = which !== 'start'; chatEl.hidden = which !== 'chat'; linkedEl.hidden = which !== 'linked';
  }
  function setDot() {
    var unread = msgs.some(function (m) { return m.sender === 'admin' && m.id > seenId; });
    dot.hidden = !unread || isOpen;
    var din = document.querySelector('.gc-dot-in'); if (din) din.hidden = !unread || isOpen;
  }
  function markSeen() {
    msgs.forEach(function (m) { if (m.sender === 'admin' && m.id > seenId) seenId = m.id; });
    store(SEEN, String(seenId)); setDot();
  }
  function bubble(m) {
    var me = m.sender !== 'admin';
    var body = '';
    if (m.body) body += (m.is_html && !me) ? '<div class="gc-rich">' + clean(m.body) + '</div>' : linkify(m.body);
    if (m.image_url && /^\/api\/chat\/img\//.test(m.image_url)) body += '<a href="' + esc(m.image_url) + '" target="_blank" rel="noopener"><img src="' + esc(m.image_url) + '" alt="image"></a>';
    return '<div class="gc-msg ' + (me ? 'me' : 'them') + '" data-id="' + m.id + '">' + (me ? '' : '<span class="gc-who">LE888 Support</span>') +
      '<div class="gc-bub">' + body + '</div><span class="gc-time">' + timeOf(m.created_at) + '</span></div>';
  }
  function render() {
    var hello = '<div class="gc-msg them gc-hello"><span class="gc-who">LE888 Support</span><div class="gc-bub">Hi ' + esc(gname || 'there') +
      '! 👋 Send us your question and our team will reply here. You can close this and come back later on this phone.</div></div>';
    listEl.innerHTML = hello + msgs.map(bubble).join('');
    listEl.scrollTop = listEl.scrollHeight;
  }
  function addMsgs(list, deleted) {
    var changed = false;
    (list || []).forEach(function (m) {
      if (m.id > lastId) lastId = m.id;
      if (!msgs.some(function (x) { return x.id === m.id; })) { msgs.push(m); changed = true; }
    });
    if (deleted && deleted.length) {
      var before = msgs.length;
      msgs = msgs.filter(function (m) { return deleted.indexOf(m.id) === -1; });
      if (msgs.length !== before) changed = true;
    }
    return changed;
  }
  function resetChat(msg) {
    token = ''; gname = ''; msgs = []; lastId = 0; store(KEY, null);
    if (isOpen) { view('start'); if (msg) $('.gc-start .gc-err').textContent = msg; }
    setDot();
  }
  function handleCommon(d) {
    if (d && d.linked) { linked = true; store(KEY, null); token = ''; if (isOpen) view('linked'); dot.hidden = true; stopPoll(); return true; }
    if (d && d.reset) { resetChat('That chat has ended. Please start a new one.'); return true; }
    return false;
  }
  function poll(full) {
    if (!token) return Promise.resolve();
    return post('list', { after_id: full ? 0 : lastId, mark_read: isOpen }).then(function (d) {
      if (handleCommon(d)) return;
      if (!d.ok) return;
      if (full) { msgs = []; lastId = 0; }
      var changed = addMsgs(d.messages, d.deleted_ids);
      if (isOpen && (changed || full)) { render(); markSeen(); }
      else setDot();
    }).catch(function () {});
  }
  function stopPoll() { clearInterval(timer); timer = null; }
  function startPoll() {
    stopPoll();
    if (!token) return;
    timer = setInterval(function () { if (!document.hidden) poll(false); }, isOpen ? 4000 : 30000);
  }

  // "Forgot password?" opens the chat with this first message ready.
  var FORGOT_MSG = 'Hi, I forgot my password. Please help me reset it.';
  var pendingFirst = '';
  var LEAD = {
    help: 'Need help? Tell us who you are and our team will reply here.',
    old: 'Enter your <b>LE888 Player ID</b> and the <b>full name registered in your account</b>, and our team will reply here.',
    'new': 'Welcome! Enter your <b>full name</b> and <b>phone number</b>, and our team will help you get started.',
    forgot: '<b>Forgot your password?</b> Enter your <b>LE888 Player ID</b> and the <b>full name registered in your account</b>. Our team will check it and help you reset your password here.'
  };
  var startMode = 'help', who = '';
  // "I'm an existing LE888 player" -> Player ID + name.  "I'm a new player" -> name + phone.
  function pickWho(w, quiet) {
    who = w;
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-who]'), function (b) { var on = b.getAttribute('data-who') === w; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    $('.gc-fields').hidden = !w;
    $('.gc-f-id').hidden = w !== 'old'; $('.gc-f-phone').hidden = w !== 'new';
    $('.gc-name-hint').hidden = w !== 'old';
    $('.gc-start .gc-err').textContent = '';
    if (startMode !== 'forgot') $('.gc-lead').innerHTML = w ? LEAD[w] : LEAD.help;
    if (w && !quiet) setTimeout(function () { try { $('#gc-name').focus(); } catch (e) {} }, 50);
  }
  Array.prototype.forEach.call(wrap.querySelectorAll('[data-who]'), function (b) { b.onclick = function () { pickWho(b.getAttribute('data-who')); }; });
  function open(mode) {
    var forgot = mode === 'forgot';
    pendingFirst = forgot ? FORGOT_MSG : '';
    startMode = forgot ? 'forgot' : 'help';
    $('.gc-lead').innerHTML = forgot ? LEAD.forgot : LEAD.help;
    // Forgot password = existing player for sure: skip the choice.
    $('.gc-pick').hidden = forgot;
    pickWho(forgot ? 'old' : who, true);
    isOpen = true; wrap.hidden = false; document.documentElement.classList.add('gc-lock');
    fab.hidden = true;
    if (linked) { view('linked'); return; }
    if (token && forgot && !ta.value.trim()) ta.value = 'Hi, I forgot my password. My Player ID is ';
    if (!token) {
      view('start');
      if (who) setTimeout(function () { try { $('#gc-name').focus(); } catch (e) {} }, 200);
      return;
    }
    view('chat'); render(); markSeen();
    poll(true); startPoll();
    setTimeout(function () { try { ta.focus(); } catch (e) {} }, 200);
  }
  function close() {
    isOpen = false; wrap.hidden = true; document.documentElement.classList.remove('gc-lock');
    fab.hidden = !fabWanted; setDot(); startPoll();
    if (linked) { linked = false; view('start'); }
  }
  fab.onclick = function () { open('help'); };
  var fabWanted = false; // floating button shows only when the in-page Live Chat button is off screen
  Array.prototype.forEach.call(wrap.querySelectorAll('[data-gc-close]'), function (b) { b.addEventListener('click', close); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) close(); });

  // ---------- Start a chat ----------
  $('.gc-start .gc-go').onclick = function () {
    var err = $('.gc-start .gc-err'), btn = this;
    var name = $('#gc-name').value.replace(/\s+/g, ' ').trim();
    var digits = $('#gc-phone').value.replace(/\D/g, '');
    var pidv = $('#gc-pid').value.replace(/\s+/g, '').toUpperCase();
    var forgot = startMode === 'forgot';
    var hasId = forgot || who === 'old';
    if (!who && !forgot) { err.textContent = 'Please choose: I\'m an existing LE888 player, or I\'m a new player.'; return; }
    if (name.length < 2) { err.textContent = 'Please enter your full name.'; $('#gc-name').focus(); return; }
    if (hasId) {
      if (!/^[A-Z0-9_.]{3,32}$/.test(pidv)) { err.textContent = 'Please enter your LE888 Player ID, e.g. LE10695.'; $('#gc-pid').focus(); return; }
    } else {
      if (/^[3689]\d{7}$/.test(digits)) { err.textContent = 'Please add the country code 65 in front, e.g. 65' + digits + '.'; $('#gc-phone').focus(); return; }
      if (digits.length < 10 || digits.length > 15 || (/^65/.test(digits) && !/^65[3689]\d{7}$/.test(digits))) { err.textContent = 'Please enter your phone number with country code, e.g. 6591234567.'; $('#gc-phone').focus(); return; }
    }
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Starting…';
    post('start', hasId ? { name: name, player_id: pidv } : { name: name, phone: digits, new_player: true }).then(function (d) {
      btn.disabled = false; btn.innerHTML = 'Start chat <span aria-hidden="true">→</span>';
      if (!d.ok || !d.token) { err.textContent = d.error || 'Could not start the chat. Please try again.'; return; }
      token = d.token; gname = d.name || name; msgs = []; lastId = 0;
      store(KEY, JSON.stringify({ t: token, n: gname }));
      view('chat'); render(); startPoll();
      // Came from "Forgot password?": send that first message for them.
      if (pendingFirst) { ta.value = forgot ? pendingFirst + ' My Player ID is ' + pidv + '.' : pendingFirst; pendingFirst = ''; send(); }
      setTimeout(function () { try { ta.focus(); } catch (e) {} }, 100);
    }).catch(function () { btn.disabled = false; btn.innerHTML = 'Start chat <span aria-hidden="true">→</span>'; err.textContent = 'Connection unavailable. Please try again.'; });
  };

  // ---------- Send ----------
  function send() {
    var text = ta.value.trim(), err = $('.gc-send-err');
    if (!text || sending || !token) return;
    sending = true; sendBtn.disabled = true; err.textContent = '';
    post('send', { body: text }).then(function (d) {
      sending = false; sendBtn.disabled = false;
      if (handleCommon(d)) return;
      if (!d.ok) { err.textContent = d.error || 'Message not sent. Please try again.'; return; }
      ta.value = ''; ta.style.height = '';
      return poll(false);
    }).catch(function () { sending = false; sendBtn.disabled = false; err.textContent = 'Connection unavailable. Please try again.'; });
  }
  sendBtn.onclick = send;
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  ta.addEventListener('input', function () { ta.style.height = ''; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; });

  // ---------- Switch on only if enabled in Admin -> Settings ----------
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (c) {
      if (!c || c.guest_chat_enabled === false) return;
      // 1) Live Chat button in the "Contact us" spot (replaces WhatsApp / Telegram).
      var box = document.querySelector('#login-contact'), inline = null;
      if (box) {
        box.innerHTML = '<span class="lc-label">Contact us</span>' +
          '<button type="button" class="gc-inline"><span aria-hidden="true">💬</span> Live Chat<span class="gc-dot gc-dot-in" hidden></span></button>';
        box.hidden = false;
        inline = box.querySelector('.gc-inline');
        inline.onclick = function () { open('help'); };
      }
      // 2) Floating button only when that one is not on screen (e.g. sign-up form).
      var showFab = function (v) { fabWanted = v; if (!isOpen) fab.hidden = !v; };
      if (inline && 'IntersectionObserver' in window) {
        new IntersectionObserver(function (es) { showFab(!es[0].isIntersecting); }).observe(inline);
      } else showFab(true);
      // 3) "Forgot password?" goes straight to Live Chat.
      var fp = document.querySelector('#forgot-password');
      if (fp) fp.onclick = function () { var rn = document.querySelector('#recovery-note'); if (rn) rn.hidden = true; open('forgot'); };
      if (token) { poll(true); startPoll(); }
    }).catch(function () {});
})();
