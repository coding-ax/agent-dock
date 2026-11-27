// Minimal pass-through Service Worker for Chrome PWA installability.
// Intentionally does NOT cache /api/, SSE streams, ?t= auth links, or dynamic HTML
// to avoid stale state or auth cookie anomalies.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.searchParams.has('t')) return;
  const accept = request.headers.get('accept') || '';
  if (accept.includes('text/event-stream')) return;
  // Pass through directly to network without caching.
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  const targetUrl = sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : '/';
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if (sessionId && 'postMessage' in client) {
          client.postMessage({ type: 'agentdock:notification-click', sessionId });
        }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
