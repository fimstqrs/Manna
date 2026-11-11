/* Manna offline helper.
   - The page itself: try the network first (so updates arrive straight away), fall back to the saved copy when offline.
   - Data, fonts and icons: they never change once published (their names include a version), so serve the saved copy instantly.
   - The /api functions are never cached. */
const CACHE = 'manna-v2';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'favicon.svg', 'apple-touch-icon.png',
  'fonts/jost-latin-400-normal.woff2', 'fonts/jost-latin-500-normal.woff2', 'fonts/jost-latin-600-normal.woff2',
  'fonts/cormorant-garamond-latin-600-italic.woff2', 'fonts/cormorant-garamond-latin-600-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('/version.json')) return;
  const page = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (page) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); } return r; })
      .catch(() => caches.match('index.html').then(r => r || caches.match('./'))));
    return;
  }
  /* The manifest and app icons: use the newest copy when online, so a new logo shows up */
  if (/\.webmanifest$/.test(url.pathname) || /\/(icons\/|favicon|apple-touch-icon|safari-pinned-tab)/.test(url.pathname)) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  if (/\/(data|fonts)\//.test(url.pathname) || /\.(woff2|png|svg|ico)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })));
  }
});
