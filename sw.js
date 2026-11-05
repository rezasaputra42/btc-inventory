/* Service worker BTC INVENTORY
   - Menyimpan file aplikasi agar bisa dibuka cepat dan tetap tampil saat sinyal buruk.
   - Selalu mencoba mengambil versi terbaru lebih dulu (jadi pembaruan aplikasi langsung terpakai).
   - Data Supabase TIDAK pernah disimpan di sini: stok selalu diambil langsung dari server. */
const CACHE = 'btc-inventory-v1';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'supabase.js', 'xlsx.js', 'html5-qrcode.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(FILES.map((f) => c.add(new Request(f, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase & lainnya: langsung ke jaringan

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await Promise.race([
        fetch(req, { cache: 'no-cache' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
      ]);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const hit = (await cache.match(req, { ignoreSearch: true })) ||
                  (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
