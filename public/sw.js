/* ============================================================================
   LE888 service worker
   - Versioned cache; old caches cleaned on activate.
   - NEVER caches API responses (all /api/*) or any non-GET request.
   - NEVER caches the admin app.
   - HTML: ALWAYS from the network (never saved, so no player's page is ever
     stored on the phone). If the phone is offline, a small "You're offline"
     screen is shown instead of a browser error.
   - App code/styles (.js/.css): network-first, so updates show on the first refresh.
   - Static artwork/shell: cache-first for reliable offline loading.
   Balances, prizes, payout and account data always come from the network.
   ============================================================================ */
'use strict';

var CACHE = 'tr666-v176';
var STATIC = ['/manifest-game.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-180.png', '/icon-maskable-512.png'];

var OFFLINE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#060606"><title>LE888 · Offline</title><style>html,body{margin:0;height:100%;background:#060606;color:#f5ead6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}body{display:grid;place-items:center;padding:24px;box-sizing:border-box;text-align:center}img{width:112px;height:112px;border-radius:26px;box-shadow:0 10px 34px rgba(233,189,90,.35)}h1{margin:22px 0 6px;font-size:22px;color:#ffe3a0}p{margin:0 0 22px;color:#b8ac92;font-size:15px;line-height:1.5}button{border:0;border-radius:999px;padding:14px 28px;font:800 15px inherit;font-family:inherit;color:#1a1206;background:linear-gradient(180deg,#fff0b8,#e9bd5a 55%,#a8742a);box-shadow:0 8px 22px rgba(233,189,90,.35)}</style></head><body><main><img src="/icon-192.png" alt="LE888"><h1>You\u2019re offline</h1><p>Please check your internet connection,<br>then tap Try again.</p><button onclick="location.reload()">Try again</button></main></body></html>';

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(STATIC).catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  // Bypass everything that must always be live: non-GET (all API POSTs),
  // API routes, and the admin app. Nothing here is ever cached.
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;             // skip cross-origin (fonts, etc.)
  if (url.pathname.indexOf('/api/') === 0) return;
  if (req.headers.has('range')) return;                          // videos: let the browser stream them
  if (url.pathname === '/admin' || url.pathname.indexOf('/admin') === 0) return;

  var isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isHTML) {
    // Network only. Pages are never saved (they can hold a player's details).
    // Offline -> friendly offline screen instead of the browser's error page.
    e.respondWith(
      fetch(req).catch(function () {
        return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      })
    );
    return;
  }

  // App code + styles (.js / .css): network-first so a new upload shows on the
  // FIRST refresh. The saved copy is only used when the phone is offline.
  if (/\.(js|css)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then(function (res) {
        var ct = (res && res.headers.get('content-type')) || '';
        if (res && res.status === 200 && res.type === 'basic' && ct.indexOf('text/html') === -1) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  // Static assets (icons, manifest, artwork): cache-first, then network.
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // Only cache a real asset. If the server fell back to the HTML app
        // page (file missing at that moment), never cache that for an asset URL.
        var ct = (res && res.headers.get('content-type')) || '';
        if (res && res.status === 200 && res.type === 'basic' && ct.indexOf('text/html') === -1) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return hit; });
    })
  );
});

// ---- Web Push ----
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(Promise.all([
    self.registration.showNotification(data.title || 'LE888', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // A "new link" push carries an absolute url; tapping it opens the new
      // web address even if this old one is blocked. Everything else uses '/'.
      data: { url: data.url || '/' }
    }),
    // Tell any open app window to play a notification sound.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) list[i].postMessage({ type: 'tr666-push', kind: data.kind || 'normal' });
    })
  ]));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  var external = /^https?:\/\//i.test(url);
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    // A "new link" (absolute url) must ALWAYS open the new address in a fresh
    // window — never just refocus the old, possibly-dead app.
    if (external) { if (clients.openWindow) return clients.openWindow(url); return; }
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});
