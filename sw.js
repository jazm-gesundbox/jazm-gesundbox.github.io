// MyGesundBox Service Worker – Netzwerk zuerst, offline aus dem Cache.
// Bei eingeschalteten Erinnerungen liegt zusätzlich eine Liste von Daten ohne Titel, Ärzte oder Inhalte im Cache „sched-gesundbox“.
const CACHE = 'gesundbox-2.6.0', SCHED = 'sched-gesundbox';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-badge-96.png', './ds.js', './boxen/smartbox.png', './boxen/gesundbox.png', './boxen/belegbox.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, {cache: 'reload'})))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('gesundbox-') && k !== CACHE).map(k => caches.delete(k)))));
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
  // Beim Öffnen gleich prüfen, ob eine Erinnerung fällig ist – auch solange die App noch gesperrt ist
  if (req.mode === 'navigate') e.waitUntil(remind(false).catch(() => {}));
  e.respondWith(
    fetch(req.url, {cache: 'no-cache', credentials: 'same-origin'}).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

/* ---------- Erinnerungen ohne Server ---------- */
self.addEventListener('message', e => { if (e.data && e.data.type === 'REMIND') e.waitUntil(remind(!!e.data.force)); });
self.addEventListener('periodicsync', e => { if (e.tag === 'gesundbox-erinnerung') e.waitUntil(remind(false)); });

const ONE = { t: 'Ein Arzttermin ist', v: 'Eine Vorsorge ist fällig', u: 'Ein Dokument läuft ab', w: 'Kontaktlinsen wechseln', n: 'Kontaktlinsen-Vorrat reicht nur noch bis' };
function dayIso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function diffDays(s, today) { const p = s.split('-').map(Number); return Math.round((new Date(p[0], p[1] - 1, p[2]) - today) / 864e5); }
const when = n => n === 0 ? 'heute' : n === 1 ? 'morgen' : 'in ' + n + ' Tagen';
function line(x) {
  if (x.t === 't') return 'Ein Arzttermin ist ' + when(x.n) + '.';
  if (x.t === 'n') return x.n === 0 ? 'Der Kontaktlinsen-Vorrat ist aufgebraucht.' : 'Der Kontaktlinsen-Vorrat reicht noch ' + x.n + (x.n === 1 ? ' Tag.' : ' Tage.');
  if (x.t === 'w') return 'Kontaktlinsen wechseln: ' + when(x.n) + '.';
  return (ONE[x.t] || 'Etwas ist fällig') + ' ' + when(x.n) + '.';
}

async function remind(force) {
  const c = await caches.open(SCHED), r = await c.match('./__sched');
  const old = await self.registration.getNotifications({ tag: 'gesundbox-erinnerung' });
  if (!r) { old.forEach(n => n.close()); return; }
  const { items = [] } = await r.json().catch(() => ({}));
  const t = new Date(); const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const soon = items.map(x => ({ t: x.t, n: diffDays(x.d, today), l: +x.l || 14 })).filter(x => x.n >= 0 && x.n <= x.l).sort((a, b) => a.n - b.n);
  if (!soon.length) { old.forEach(n => n.close()); await c.delete('./__last'); return; }
  const last = await c.match('./__last').then(x => x && x.json()).catch(() => null);
  const key = dayIso(today) + '|' + soon.length + '|' + soon[0].t + soon[0].n;
  if (!force && last && last.key === key) return;
  const body = soon.length === 1 ? line(soon[0]) : soon.length + ' Erinnerungen – als Nächstes: ' + line(soon[0]);
  await self.registration.showNotification('MyGesundBox', {
    body, tag: 'gesundbox-erinnerung', renotify: true, icon: 'icon-192.png', badge: 'icon-badge-96.png', data: { url: './' }
  });
  await c.put('./__last', new Response(JSON.stringify({ key })));
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const w = cs.find(x => new URL(x.url).origin === location.origin);
    return w ? w.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
