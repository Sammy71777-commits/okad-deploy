/**
 * OKAD AFRICA —— Cloudflare Pages Advanced 模式 Worker (_worker.js)
 *
 * 为什么要这个文件:
 *   okadafrica.com 的 NS 委派在注册商侧失效 —— .com 父区对本域返回 NOANSWER,
 *   导致 api.okadafrica.com 在公网完全无法解析(客户注册时上报 "Network error")。
 *   Cloudflare 自己的 NS 上记录是对的,只是没人把流量指过去。
 *
 *   本文件让站点通过可解析的 pages.dev 域名访问 API:
 *   - /api/*  → 反向代理到后端 Worker(走内网,不经过失效的公网 DNS)
 *   - 其他路径 → 回落到静态资源(assets)
 *
 *   注意:后端 Worker 通过 workers.dev 访问。若该账号未启用 workers.dev 路由,
 *   可用环境变量 WORKER_ORIGIN 指定后端 Worker 的其它可达地址。
 */

const ASSETS = { binding: 'ASSETS' };
const ACCOUNT_SUBDOMAIN = 'sammy71777';
const WORKER_NAME = 'shrill-wave-7c04';

/* 不应透传的逐跳头 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'host', 'content-length'
]);

function workerOrigin(env) {
  const custom = (env && env.WORKER_ORIGIN && String(env.WORKER_ORIGIN).trim()) || '';
  if (custom) return custom.replace(/\/+$/, '');
  return `https://${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev`;
}

/* 把 /api/* 转发到后端 Worker */
async function proxyApi(request, env, url) {
  const apiPath = url.pathname.replace(/^\/api/, '');
  const target = `${workerOrigin(env)}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  }

  const init = {
    method: request.method,
    headers,
    redirect: 'manual'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Upstream API unreachable',
        detail: String(err && err.message ? err.message : err)
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const resHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    resHeaders.set(k, v);
  }
  if (!resHeaders.has('Content-Type')) {
    resHeaders.set('Content-Type', 'application/json; charset=utf-8');
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* API → 后端 Worker */
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return proxyApi(request, env, url);
    }

    /* 静态资源 → Pages assets */
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    /* 无 ASSETS 绑定时(本地调试)直接返回提示 */
    return new Response('OK', { status: 200 });
  }
};
