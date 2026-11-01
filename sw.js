// Piste : garde l'appli disponible sans réseau (la carte et le calcul restent en ligne)
const CACHE = 'piste-v16';
const TILES = 'piste-tiles';
const SHELL = ['./', 'index.html', 'core.js', 'moto-tt.brf', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'data.geopf.fr') {
    e.respondWith(caches.open(TILES).then(c => c.match(e.request.url)).then(hit => hit || fetch(e.request)));
    return;
  }
  const shell = url.origin === location.origin || url.hostname === 'unpkg.com' || url.hostname.endsWith('fonts.gstatic.com') || url.hostname === 'fonts.googleapis.com';
  if (!shell) return; // tuiles, BRouter, Overpass : toujours en direct
  e.respondWith(
    fetch(e.request, url.origin === location.origin ? { cache: 'no-store' } : {}).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
