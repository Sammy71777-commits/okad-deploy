/* OKAD AFRICA Service Worker — PWA offline support
 *
 * 策略：
 *   - HTML / 导航：network-first（保证新版本可用），失败 fallback 到 cache 或 offline.html
 *   - 静态资源（icon / manifest / og-cover / robots / sitemap）：cache-first
 *   - 第三方资源（Google Fonts）：stale-while-revalidate
 *
 * 版本：每发版时递增 CACHE_VERSION，旧缓存会被自动清掉
 */

const CACHE_VERSION = 'okad-v48';
const STATIC_CACHE = CACHE_VERSION + '-static';
const HTML_CACHE = CACHE_VERSION + '-html';
const OFFLINE_URL = '/offline.html';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/landing.html',
  '/manifest.json',
  '/og-cover.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/favicon-32.png',
  '/qrcode.min.js',
  '/robots.txt',
  '/sitemap.xml',
  OFFLINE_URL
];

/* 安装：预缓存核心静态资源 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache =>
      cache.addAll(STATIC_ASSETS).then(() => self.skipWaiting())
    ).catch(err => console.warn('[SW] install failed:', err))
  );
});

/* 接收页面发来的强制接管指令 */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* 激活：清理旧版本缓存 */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k.startsWith('okad-') && !k.startsWith(CACHE_VERSION))
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* 拦截请求 */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* ★ API 请求绝不缓存(网络优先,不写缓存)
     以前第三方资源一律走 staleWhileRevalidate,把 /api/db/orders 的
     响应也存进了缓存 —— 结果客户第一次拉完云端订单后,之后换设备/
     换会话拿到的都是那份旧列表,货物记录中心看不到新单。
     API 是实时数据,必须永远走网络。 */
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(req));
    return;
  }

  /* 第三方资源：stale-while-revalidate */
  if (url.origin !== self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  /* 导航请求：network-first */
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirst(req));
    return;
  }

  /* 同源静态资源：cache-first */
  event.respondWith(cacheFirst(req));
});

/* ---- 缓存策略 ---- */

/* 只走网络,失败就报错(绝不返回旧缓存) */
async function networkOnly(req) {
  try {
    return await fetch(req);
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: 'network unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(HTML_CACHE);
  try {
    const fresh = await fetch(req);
    /* 只缓存成功的 GET */
    if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    /* 离线 fallback */
    const cached = await cache.match(req);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    return new Response('Asset unavailable', { status: 503 });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(fresh => {
    if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
    return fresh;
  }).catch(() => cached);
  return cached || fetchPromise;
}
