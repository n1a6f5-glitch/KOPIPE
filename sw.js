// KOPIPE service worker – cache-first app shell, versioned. Bump VERSION on every release.
const VERSION = 'kopipe-v1.0.0';
const SHELL = [
  './', './index.html', './manifest.json', './app.js',
  './core/util.js', './core/db.js', './core/qc.js', './core/backup.js', './core/project.js', './core/zip.js', './core/log.js',
  './core/batch.js', './core/vndb.js',
  './core/engines/index.js', './core/engines/kirikiri.js', './core/engines/txt.js',
  './core/engines/artemis.js', './core/engines/scn.js', './core/engines/vntp.js',
  './icons/icon.svg', './icons/vn-bg.svg'
];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL))); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
