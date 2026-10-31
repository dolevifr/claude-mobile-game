// Offline support and notification actions.
// Bump VERSION whenever app files change so phones pick up the new version.

const VERSION = 'ozer-v2';
const FONT_CACHE = 'ozer-fonts';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/dates.js',
  './js/icons.js',
  './js/parse.js',
  './js/push.js',
  './js/reminders.js',
  './js/store.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION && k !== FONT_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
      return res;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Serve from cache right away, refresh the cache in the background.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = request.mode === 'navigate' ? './index.html' : request;
    const cached = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
    const network = fetch(request).then((res) => {
      if (res.ok && request.mode !== 'navigate') cache.put(request, res.clone());
      if (res.ok && request.mode === 'navigate') cache.put('./index.html', res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return (await network) || new Response('אין חיבור לרשת', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});

// Reminders sent by the push server (server/ folder) while the app is closed.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data?.text() };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'תזכורת', {
    body: data.body || '',
    tag: data.taskId ? `task-${data.taskId}` : `ozer-${data.type || 'push'}`,
    renotify: true,
    requireInteraction: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    lang: 'he',
    dir: 'rtl',
    vibrate: [200, 100, 200],
    data: { id: data.taskId || null },
    actions: data.taskId ? [{ action: 'done', title: 'בוצע' }, { action: 'snooze', title: 'עוד 10 דקות' }] : [],
  }));
});

// "Done" and "snooze" are handled by an open window when there is one, without bringing it forward.
// A plain tap opens the app on the reminder card (iPhone notifications have no buttons).
self.addEventListener('notificationclick', (event) => {
  const id = event.notification.data?.id;
  const action = event.action || 'open';
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows[0];
    if (!id) {
      if (client) await client.focus().catch(() => {});
      else await self.clients.openWindow('./');
      return;
    }
    if (client) {
      client.postMessage({ type: 'reminder-action', action, id });
      if (action === 'open') await client.focus().catch(() => {});
      return;
    }
    await self.clients.openWindow(`./?action=${encodeURIComponent(action)}&task=${encodeURIComponent(id)}`);
  })());
});
