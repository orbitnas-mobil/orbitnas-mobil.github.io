// Offline-Modus: Die App selbst liegt auf dem Gerät. Deine Daten (IndexedDB) fasst dieser Teil nie an.
const BUILD = "2ea0d24ee06e";
const APP_CACHE = 'orbitnas-app-' + BUILD;
const THUMBS = 'orbitnas-thumbs';
const OCR_CACHE = 'orbitnas-ocr-1';
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/addons.css",
  "./css/app.css",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./js/addcloud.js",
  "./js/app.js",
  "./js/crypto.js",
  "./js/db.js",
  "./js/fileops.js",
  "./js/files.js",
  "./js/fritz.js",
  "./js/layout.js",
  "./js/lock.js",
  "./js/opsbar.js",
  "./js/picker.js",
  "./js/player.js",
  "./js/secq.js",
  "./js/secrets.js",
  "./js/settings.js",
  "./js/store.js",
  "./js/theme.js",
  "./js/typeicons-data.js",
  "./js/typeicons.js",
  "./js/ui.js",
  "./js/unzip.js",
  "./js/upload.js",
  "./js/util.js",
  "./js/version.js",
  "./js/addons/fuel.js",
  "./js/addons/index.js",
  "./js/addons/ledger-core.js",
  "./js/addons/ledger-ui.js",
  "./js/addons/ledger.js",
  "./js/addons/notes.js",
  "./js/addons/prefs.js",
  "./js/addons/search.js",
  "./js/addons/stands.js",
  "./js/addons/store.js",
  "./js/addons/trips.js",
  "./js/addons/ui.js",
  "./js/addons/vault.js",
  "./js/scan/crop.js",
  "./js/scan/ocr.js",
  "./js/scan/page.js",
  "./js/scan/pdf.js",
  "./js/scan/vision.js",
  "./js/sources/base.js",
  "./js/sources/demo.js",
  "./js/sources/dropbox.js",
  "./js/sources/gdrive.js",
  "./js/sources/oauth.js",
  "./js/sources/onedrive.js",
  "./js/sources/pcloud.js",
  "./js/sources/registry.js"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))));
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('orbitnas-app-') && k !== APP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trimThumbs(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - 1500; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Vorschaubilder aus pCloud: einmal geladen, auch offline sichtbar
  if (url.pathname.endsWith('/getthumb') && url.hostname.endsWith('pcloud.com')) {
    e.respondWith((async () => {
      // Schlüssel ohne Anmelde-Kennung (auth), damit ein Bild nach neuer Anmeldung nicht neu geladen werden muss
      const key = new URL(url); key.searchParams.delete('auth');
      const cache = await caches.open(THUMBS);
      const hit = await cache.match(key.href);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) { cache.put(key.href, res.clone()); trimThumbs(cache); }
      return res;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Texterkennung (ocr/): beim ersten Scan laden und für später (auch offline) behalten
  if (url.pathname.includes('/ocr/')) {
    e.respondWith((async () => {
      const cache = await caches.open(OCR_CACHE);
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    })());
    return;
  }

  // App-Dateien: zuerst vom Gerät (schnell, offline)
  e.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    if (e.request.mode === 'navigate') {
      return (await cache.match('./index.html')) || fetch(e.request);
    }
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(e.request);
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
