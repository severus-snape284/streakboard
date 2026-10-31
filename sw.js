// Service worker: caches the app shell so the app opens instantly and offline.
// Bump VERSION on every release so clients pick up the new shell.
const VERSION = 'v2.2.0';
const CACHE = `streakboard-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/model.js',
  './js/streaks.js',
  './js/insights.js',
  './js/views.js',
  './js/ui.js',
  './js/api.js',
  './js/db.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('streakboard-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only handle our own static files. Habitica API calls always go to the network.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // App navigations get the cached shell; direct links to files (e.g. the widget script) don't.
  if (e.request.mode === 'navigate' && !/\.[a-z0-9]+$/i.test(url.pathname.replace(/index\.html$/, ''))) {
    e.respondWith(caches.match('./index.html').then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request))
  );
});
