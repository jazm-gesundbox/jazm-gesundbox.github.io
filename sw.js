// MyGesundBox Service Worker – Netzwerk zuerst, offline aus dem Cache
const CACHE = 'gesundbox-2.5.0';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './ds.js', './boxen/smartbox.png', './boxen/gesundbox.png', './boxen/belegbox.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, {cache: 'reload'})))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Teilen aus anderen Apps: Inhalt kurz in IndexedDB ablegen, die App übernimmt ihn nach dem Entsperren
function idbPut(k, v) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('gesundbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k);
      t.oncomplete = () => { r.result.close(); res(); }; t.onerror = () => rej(t.error); };
    r.onerror = () => rej(r.error);
  });
}
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'POST' || url.origin !== location.origin || !url.pathname.endsWith('/teilen')) return;
  e.respondWith((async () => {
    try {
      const fd = await req.formData(), files = [];
      for (const f of fd.getAll('dateien')) {
        if (f && typeof f !== 'string' && /^com\.samsung\./i.test(f.name || '') && !/blood_pressure|health\.weight|tracker\.heart_rate\.\d/i.test(f.name)) continue; // übrige Samsung-Tabellen gar nicht erst speichern
        if (f && typeof f !== 'string' && f.size && f.size < 100e6) files.push({ name: f.name || '', type: f.type || '', buf: await f.arrayBuffer() });
      }
      await idbPut('share', { at: Date.now(), title: String(fd.get('title') || ''), text: String(fd.get('text') || ''), url: String(fd.get('url') || ''), files });
    } catch (err) {}
    return Response.redirect(new URL('./?teilen=1', self.registration.scope).href, 303);
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req.url, {cache: 'no-cache', credentials: 'same-origin'}).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
