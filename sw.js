// Service worker: app shell works offline; always tries the network first so updates show immediately.
const CACHE = 'sc-accounting-v3';
const CORE = ['./', './index.html', './fb.js', './firebase-config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const LIB_HOSTS = /^(www\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  // Never touch Firebase/Firestore/Auth traffic or the customer portal.
  if (!same && !LIB_HOSTS.test(url.hostname)) return;
  if (same && url.pathname.endsWith('portal.html')) return;
  if (!same) {
    // Versioned libraries & fonts: cache first.
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  // App files: network first, fall back to cache when offline.
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))));
});

// Push notifications (sent by Cloud Functions through Firebase Cloud Messaging as data messages).
self.addEventListener('push', e => {
  let d = {};
  try { const j = e.data ? e.data.json() : {}; d = j.data || j.notification || j; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'SMART CLICK';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', dir: 'rtl', lang: 'ar', tag: d.tag || undefined, renotify: !!d.tag,
    icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.split('#')[0] === url.split('#')[0] && 'focus' in c) { c.navigate ? c.navigate(url) : 0; return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
