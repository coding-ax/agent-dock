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
