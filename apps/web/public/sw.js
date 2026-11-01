/* MAZE service worker — privacy-safe offline shell.
 *
 * Hard rule for a neo-bank: NEVER persist or serve financial/account data.
 * Balances, activity, auth, and every mutation always hit the network and are
 * never written to CacheStorage. Only the static app shell and immutable,
 * content-hashed build assets are cached. A blanket cache-first SW (what the
 * design-tool export shipped) would leak balances + serve stale money, so it
 * is deliberately NOT used here.
 */
const VERSION = 'maze-shell-v4-privy-only';

/* Guaranteed-present static shell. Hashed /assets/* bundles are intentionally
 * warmed from /app.html at install because Vite re-hashes them every build. */
const APP_SHELL = '/app.html';
const SHELL = ['/offline.html', '/manifest.webmanifest'];

/* Same-origin paths that must always be network-only (never cached). Note the
 * shell entries (index/app/landing/portal/developers/prototype-review) do NOT
 * match, so they stay cacheable; checkout (live payment) is intentionally here. */
const PRIVATE_PATH =
  /^\/(api|auth|ledger|account|balance|activity|me|earn|swap|payments?|cards?|agents?|bridge|markets?|campaigns?|perks?|keys|offers|checkout|healthz|mcp)\b/i;

function isPrivate(url, req) {
  if (req.method !== 'GET') return true; // sends, top-ups, freezes: never replay
  if (url.origin !== self.location.origin) return true; // API host + 3rd-party: hands off
  if (PRIVATE_PATH.test(url.pathname)) return true;
  if ((req.headers.get('accept') || '').includes('text/event-stream')) return true; // SSE
  return false;
}

async function warmAppShell(cache) {
  try {
    const res = await fetch(APP_SHELL, { cache: 'reload' });
    if (!res.ok) throw new Error(`app shell ${res.status}`);
    await cache.put(APP_SHELL, res.clone());
    const html = await res.text();
    const urls = new Set();
    const re = /(?:src|href)=["']([^"']+)["']/g;
    let match;
    while ((match = re.exec(html))) {
      const raw = match[1];
      if (!raw || raw.startsWith('data:') || raw.startsWith('http')) continue;
      const url = new URL(raw, self.location.origin);
      if (url.origin !== self.location.origin) continue;
      if (/^\/(assets|fonts|icons|src)\//.test(url.pathname)) {
        urls.add(url.pathname + url.search);
      }
    }
    await Promise.allSettled(Array.from(urls).map((url) => cache.add(url)));
  } catch {
    await cache.add(APP_SHELL).catch(() => {});
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then(async (c) => {
        await c.addAll(SHELL);
        await warmAppShell(c);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('push', (e) => {
  let payload;
  try {
    payload = e.data ? e.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === 'string' ? payload.title : 'MAZE activity';
  const body = typeof payload.body === 'string' ? payload.body : 'Open MAZE to view your latest update.';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/app.html#s29';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data && typeof e.notification.data.url === 'string'
    ? e.notification.data.url
    : '/app.html#s29';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const target = new URL(url, self.location.origin).toString();
      for (const client of clients) {
        if ('focus' in client && client.url.startsWith(self.location.origin)) {
          return client.focus().then(() => client.navigate(target));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // 1) Anything dynamic/private: bypass the SW entirely (plain network fetch).
  if (isPrivate(url, req)) return;

  // 2) Navigations: network-first; offline falls back to that page, then the
  //    app shell (so the hash router still boots), then the offline notice.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then(
            (hit) => hit || caches.match('/app.html').then((shell) => shell || caches.match('/offline.html')),
          ),
        ),
    );
    return;
  }

  // 3) Static same-origin GETs (hashed /assets/*, /fonts/*, /icons/*, css):
  //    stale-while-revalidate. Content-hashing makes serving the cached copy safe.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
