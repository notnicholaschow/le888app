/* ============================================================================
   LE888 service worker
   - Versioned cache; old caches cleaned on activate.
   - NEVER caches API responses (all /api/*) or any non-GET request.
   - NEVER caches the admin app.
   - HTML: network-first, so a new deploy is never trapped behind a stale page.
   - Static artwork/shell: cache-first for reliable offline loading.
   Balances, prizes, payout and account data always come from the network.
   ============================================================================ */
'use strict';

var CACHE = 'tr666-v117';
var STATIC = ['/', '/manifest-game.webmanifest', '/icon-192.png'];

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
  if (url.pathname === '/admin' || url.pathname.indexOf('/admin') === 0) return;

  var isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isHTML) {
    // Network-first: fresh HTML on every load; cached shell only when offline.
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('/', copy); }).catch(function () {});
        return res;
      }).catch(function () {
        return caches.match('/').then(function (m) { return m || caches.match(req); });
      })
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
