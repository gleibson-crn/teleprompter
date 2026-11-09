// Service worker: cache-first de todos os arquivos do app (funciona offline).
// AO PUBLICAR NOVA VERSÃO: incremente VERSION — é o que dispara a atualização nos celulares.
const VERSION = 'v4';
const CACHE = `teleprompter-${VERSION}`;
// Detector de rosto (~12 MB): fora da instalação; guardado no 1º uso do Vertical inteligente.
// Cache próprio, sem versão do app, para não baixar de novo a cada atualização.
const VENDOR_CACHE = 'teleprompter-vendor-mediapipe-0.10.34';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/audio.js',
  'js/capture.js',
  'js/icons.js',
  'js/prompter.js',
  'js/reframe.js',
  'js/store.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  const keep = [CACHE, VENDOR_CACHE];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('teleprompter-') && !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(
      caches.open(VENDOR_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).catch(() => caches.match('index.html'))),
  );
});
