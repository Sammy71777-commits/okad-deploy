/**
 * OKAD Worker - Production Version
 * Core routes: /api/muse, /api/send-otp, /api/verify-otp, /api/exchange-rates,
 *              /api/db/{table}, /api/search, /api/config, /api/brevo-health
 * OTP: Brevo email. Needs KV namespace bound as OTPS + env BREVO_API_KEY.
 */

/* ========== 来源锁 + 通用限流 + 管理密钥 ==========
   静态前端藏不住密钥,Origin 头也能被脚本伪造,所以这里不是"绝对鉴权":
   Origin 白名单挡掉浏览器第三方站点和随手直调,IP 限流挡住刷子,
   真正敏感的数据接口另有 X-Admin-Key。三层叠加才是实际防护。 */
/* 白名单三处曾漏写,导致后台"保存成功"但云端根本没变:
   1) okad-africa.pages.dev —— Pages 项目的正式域名(不带子域前缀),原来正则要求
      [a-z0-9-]+. 前缀,只有 241de1c6.okad-africa.pages.dev 这种部署预览地址能过;
   2) *.sg.agentos-app.run —— 平台预览域;
   3) 预览域名 hash 每次部署会变,写死一个迟早又被打回。
   统一放宽到"项目自有域名 + 平台预览域",第三方站点仍然 403。 */
const ALLOWED_ORIGIN_RE = /^https:\/\/(?:www\.)?okadafrica\.com$|^https:\/\/okad-africa\.pages\.dev$|^https:\/\/[a-z0-9-]+\.okad-africa\.pages\.dev$|^https:\/\/[a-z0-9-]+\.sg\.agentos-app\.run$|^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;
function originTrust(req) {
  const o = (req.headers.get('Origin') || '').replace(/\/+$/, '').toLowerCase();
  if (!o) return 'none';                       /* curl / 脚本直调 / 部分 PWA standalone */
  return ALLOWED_ORIGIN_RE.test(o) ? 'ok' : 'bad';
}
/* clientIp() 复用文件后段已有的同名实现,这里不再重复声明 */
/* 按 path 选限流桶(每小时/IP)。KV 计数非原子,并发会略超卖 —— 防刷够用,不当精确计费。 */
function rateRule(path, method) {
  if (path === '/api/search') return { k: 'search', n: 30 };
  if (path === '/api/send-otp' || path === '/api/email-code') return { k: 'otp', n: 12 };
  if (path === '/api/verify-otp') return { k: 'otpverify', n: 30 };
  if (path === '/api/notify/email') return { k: 'mail', n: 20 };
  if (path === '/api/muse') return { k: 'muse', n: 15 };
  if (path.indexOf('/api/db/') === 0 && method !== 'GET') return { k: 'dbwrite', n: 60 };
  if (path === '/api/payment') return { k: 'payment', n: 60 };
  return { k: 'general', n: 120 };
}
/* 限流计数:纯内存,零 KV 写入。
   原实现每个请求都写一次 KV,后来改成「内存为主 + 每分钟落一次盘」——
   但 _rlMem 是 isolate 级内存,Worker 冷启动 / 换边缘节点就清空,
   每个新 isolate 里每个 IP 首次请求 cur.last=0 必然又落一次盘,
   边缘节点一多,每天轻松写满免费版 1000 次(code 10048),额度一满限流反而失效。
   现在彻底不落盘:内存判定依然即时准确(防刷够用,注释早写明「不当精确计费」),
   跨节点不累加是可接受的取舍,且完全不消耗 KV 写入额度。 */
const _rlMem = new Map();
async function rateAllow(env, ip, bucket, limit) {
  const hour = new Date().toISOString().slice(0, 13);
  const k = 'rl:' + bucket + ':' + hour + ':' + ip;
  let cur = _rlMem.get(k);
  if (!cur) { cur = { n: 0, last: Date.now() }; _rlMem.set(k, cur); }
  cur.n += 1;
  const now = Date.now();
  if (_rlMem.size > 2000) {                /* 惰性清理两小时前的条目 */
    for (const [kk, vv] of _rlMem) if (now - vv.last > 7200000) _rlMem.delete(kk);
  }
  return cur.n < limit;
}

/* ── KV 写保护 ─────────────────────────────────────────────────
   Workers KV 免费额度只有 1000 次写入/天,超额后 put/delete 会直接抛异常
   (code 10048),未捕获就变成 1101 —— 登录、发验证码、上传证件照、搜索缓存
   全部连抱,客户表现为"注册成功却一直登不了"。
   关键写入统一走 kvPut/kvDel:写失败只记日志,绝不打断业务流程。 */
async function kvPut(env, key, value, opts) {
  if (!env.OTPS) return false;
  try { await env.OTPS.put(key, value, opts); return true; }
  catch (e) {
    console.warn('[kv] put failed', key, String(e && e.message || e).slice(0, 110));
    return false;
  }
}
async function kvDel(env, key) {
  if (!env.OTPS) return false;
  try { await env.OTPS.delete(key); return true; }
  catch (e) {
    console.warn('[kv] del failed', key, String(e && e.message || e).slice(0, 110));
    return false;
  }
}
/* ── 认证存储:D1 主 + KV 备 ───────────────────────────────────────────
   Workers KV 免费版只有 1000 次写入/天(账户级,UTC 0 点重置),打满后
   put/delete 抛 code 10048 → 验证码发不出、会话写不进、退出删不掉。
   D1 免费版是 10 万行写入/天(100 倍余量),项目已在用同一个 DB,
   所以认证类数据(OTP / 冷却 / 日限 / 会话 / 密码失败计数 / WA 链接)
   统一走这里:写以 D1 为主,KV 只作降级;读 D1 优先、KV 兜底,
   这样配额打满前已落在 KV 的旧验证码仍然校验得了,不丢数据。

   刻意不迁的两类(避免拿高频/大对象去耗 D1 额度):
     · 搜索缓存 search:  —— 已是内存 L1 + KV 只读 L2
     · 证件照 kyc_photo: —— 最大 3MB,超过 D1 单行 2MB 上限,继续走 kvPut
   D1 免费额度同样是账户级且超额也会报错,所以只放低频认证数据。 */
let _storeReady = false;
let _kvWriteDeadUntil = 0;

function kvWriteDead() { return Date.now() < _kvWriteDeadUntil; }
function markKvDead(e) {
  const m = String(e && e.message || e);
  if (/10048|usage limit|free usage limit/i.test(m)) _kvWriteDeadUntil = Date.now() + 3600000;
}

async function ensureStoreTable(env) {
  if (_storeReady) return true;
  if (!env.DB) return false;
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS okad_store (' +
      'k TEXT PRIMARY KEY, v TEXT, exp INTEGER DEFAULT 0)'
    ).run();
    _storeReady = true;
  } catch (e) {
    console.warn('[store] create table failed', String(e && e.message || e).slice(0, 110));
  }
  return _storeReady;
}
function storeOk(env) { return !!(env.DB || env.OTPS); }

async function storePut(env, key, value, opts) {
  const val = String(value);
  const exp = (opts && opts.expirationTtl)
    ? Date.now() + Number(opts.expirationTtl) * 1000 : 0;
  if (env.DB) {
    try {
      await ensureStoreTable(env);
      if (_storeReady) {
        await env.DB.prepare(
          'INSERT INTO okad_store (k, v, exp) VALUES (?, ?, ?) ' +
          'ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp'
        ).bind(key, val, exp).run();
        return true;
      }
    } catch (e) {
      console.warn('[store] d1 put failed', key, String(e && e.message || e).slice(0, 110));
    }
  }
  /* D1 不可用(未绑定 / 额度也打满)→ 退回 KV,明天 KV 重置后仍可用。
     这里刻意不套 kvWriteDead() 熔断:降级写是最后一道防线、频率极低,
     且 UTC 0 点 KV 恢复后必须能立刻接住,不能被 1 小时熔断挡在门外。 */
  if (env.OTPS) {
    try { await env.OTPS.put(key, val, opts); return true; }
    catch (e) { markKvDead(e); console.warn('[store] kv fallback put failed', key, String(e && e.message || e).slice(0, 90)); }
  }
  return false;
}

async function storeGet(env, key, opts) {
  const now = Date.now();
  if (env.DB) {
    try {
      await ensureStoreTable(env);
      if (_storeReady) {
        const r = await env.DB.prepare(
          'SELECT v, exp FROM okad_store WHERE k = ? LIMIT 1'
        ).bind(key).first();
        if (r && r.v !== null && r.v !== undefined && (!r.exp || r.exp > now)) {
          if (opts && opts.type === 'json') {
            try { return JSON.parse(r.v); } catch (e) { return null; }
          }
          return r.v;
        }
      }
    } catch (e) {
      console.warn('[store] d1 get failed', key, String(e && e.message || e).slice(0, 110));
    }
  }
  /* D1 没命中(或不可用)→ 读 KV:兼容迁移前旧数据 + D1 降级写入的数据 */
  if (env.OTPS) {
    try { return await env.OTPS.get(key, opts); } catch (e) { return null; }
  }
  return null;
}

async function storeDel(env, key) {
  let ok = false;
  if (env.DB) {
    try {
      await ensureStoreTable(env);
      if (_storeReady) {
        await env.DB.prepare('DELETE FROM okad_store WHERE k = ?').bind(key).run();
        ok = true;
      }
    } catch (e) {
      console.warn('[store] d1 del failed', key, String(e && e.message || e).slice(0, 90));
    }
  }
  /* KV 侧也要删(旧数据 / 降级写入的数据)。
     D1 已删干净且 KV 已知不可写 → 跳过,别做无效请求(读永远 D1 优先)。
     但 D1 没删成时,无论熔断与否都要试一次 KV,否则旧码会残留。 */
  if (env.OTPS && (!ok || !kvWriteDead())) {
    try { await env.OTPS.delete(key); ok = true; }
    catch (e) { markKvDead(e); }
  }
  return ok;
}

function adminKeyOk(req, env, url) {
  if (!env.ADMIN_KEY) return true;            /* 未配置 → 兼容模式,先靠 Origin + 限流 */
  const k = req.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
  return k === env.ADMIN_KEY;
}
/* 只锁后台/敏感接口。/api/db/* 的 GET 是客户查单、My Cargo 的核心链路,绝不能锁;
   /api/kyc/photo 的 POST 是客户注册上传证件,也只能锁 GET。 */
function needsAdminKey(path, method) {
  if (path.indexOf('/api/db/') === 0 && method !== 'GET') return true;
  if (path === '/api/kyc/photo' && method === 'GET') return true;
  if (path === '/api/users/stats' || path === '/api/users/detail') return true;
  if (path === '/api/auth/wa-requests') return true;
  if (path === '/api/notify/email' || path === '/api/brevo-health' || path === '/api/search-health') return true;
  /* 改收款账号 = 改资金去向,必须锁管理密钥。GET 公开(客户要看收款信息)。 */
  if (path === '/api/payment' && method !== 'GET') return true;
  return false;
}
function isReadSensitive(path, method) {
  if (path === '/api/users/stats' || path === '/api/auth/wa-requests'
      || path === '/api/brevo-health' || path === '/api/search-health') return true;
  if (path === '/api/kyc/photo' && method === 'GET') return true;
  return false;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    /* ---- 来源锁:浏览器请求带 Origin,第三方站点/伪造域直接 403 ---- */
    const _trust = originTrust(req);
    if (_trust === 'bad') return json({ ok: false, error: 'Forbidden origin' }, 403);

    if (req.method === 'OPTIONS') {
      const _o = (req.headers.get('Origin') || '').replace(/\/+$/, '');
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': _o || 'https://okadafrica.com',
          'Vary': 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
        }
      });
    }

    /* ---- 通用限流:按 IP + 小时桶 ---- */
    const _rr = rateRule(path, req.method);
    if (!(await rateAllow(env, clientIp(req), _rr.k, _rr.n))) {
      return json({ ok: false, error: 'Rate limit exceeded. Please try again later.' }, 429);
    }
    /* 无 Origin 的直调(curl/脚本):不放行到只读敏感接口;自检需带 Origin 头 */
    if (_trust === 'none' && isReadSensitive(path, req.method)) {
      return json({ ok: false, error: 'Forbidden' }, 403);
    }
    /* 管理密钥:仅当 ADMIN_KEY 已配置时强制,未配置是兼容模式(靠 Origin + 限流) */
    if (needsAdminKey(path, req.method) && !adminKeyOk(req, env, url)) {
      return json({ ok: false, error: 'Admin key required' }, 401);
    }

    if (req.method === 'GET' && path === '/') {
      return json({
        ok: true,
        service: 'OKAD Worker Production',
        /* 不再公开列出全部路由 —— 等于给爬虫/刷子递菜单。
           需要排查时用 /api/search-health(带管理密钥)。 */
        status: 'ok',
        muse_configured: !!env.OPENROUTER_API_KEY,
        email_configured: !!env.BREVO_API_KEY,
        mail_from: env.MAIL_FROM || DEFAULT_MAIL_FROM,
        otp_kv_bound: !!env.OTPS,
        otp_store: env.DB ? 'd1' : (env.OTPS ? 'kv' : 'none'),
        db_configured: !!env.DB,
        search_configured: !!(env.SERPAPI_KEY || env.SERPER_API_KEY || env.TAVILY_API_KEY || env.BOCHA_API_KEY || env.OPENROUTER_API_KEY),
        ts: Date.now()
      });
    }

    /* 自检:确认 key 有效 + 列出 Brevo 里已验证的发件人(排错用) */
    if (path === '/api/brevo-health' && req.method === 'GET') {
      if (!env.BREVO_API_KEY) return json({ ok:false, error:'BREVO_API_KEY not configured' });
      try {
        const r = await fetch('https://api.brevo.com/v3/senders', { headers: { 'api-key': env.BREVO_API_KEY } });
        const d = await r.json();
        return json({
          ok: r.ok,
          brevo_status: r.status,
          senders: (d.senders || []).map(function(s){ return s.email + (s.active ? ' (active)' : ' (inactive)'); }),
          current_from: env.MAIL_FROM || DEFAULT_MAIL_FROM
        });
      } catch (e) { return json({ ok:false, error:String(e) }); }
    }

    if (path === '/api/muse' && req.method === 'POST') {
      return handleMuse(req, env);
    }

    if (path === '/api/notify/email' && req.method === 'POST') {
      return handleNotifyEmail(req, env);
    }

    /* 旧路由,向后兼容:老版前端还在调它,统一走新的 OTP 流程 */
    if (path === '/api/email-code' && req.method === 'POST') {
      return handleSendOtp(req, env);
    }

    if (path === '/api/send-otp' && req.method === 'POST') {
      return handleSendOtp(req, env);
    }

    if (path === '/api/verify-otp' && req.method === 'POST') {
      return handleVerifyOtp(req, env);
    }

    /* 6 位密码登录 / 免密会话 */
    if (path.indexOf('/api/auth/') === 0) {
      /* WhatsApp 登录链接走独立 handler(它不按 email 定位,而是按 token) */
      if (path === '/api/auth/wa-request' || path === '/api/auth/wa-verify' || path === '/api/auth/wa-requests') {
        return handleWaAuth(req, env, path, url);
      }
      return handleAuth(req, env, path, url);
    }

    if (path === '/api/exchange-rates' && req.method === 'GET') {
      return handleFx(req, env, ctx);
    }

    if (path === '/api/search' && req.method === 'POST') {
      return handleSearch(req, env, ctx);
    }

    if (path === '/api/config' && req.method === 'GET') {
      return handleConfig(env);
    }

    /* 支付信息:管理员写入 D1,客户端读取。以前只存浏览器本地存储,
       换设备就看不到管理员改的账号 —— 这是「改了没反应」的真正原因。 */
    if (path === '/api/payment') {
      if (req.method === 'GET') return handlePaymentGet(req, env);
      if (req.method === 'POST') return handlePaymentSave(req, env);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    /* 图片代理:第三方商品图经 Worker 转发,绕开防盗链 / 混合内容 / CORS */
    if (path === '/api/img' && req.method === 'GET') {
      return handleImageProxy(url);
    }

    /* 搜索上游自检:不改任何密钥,只回报 SerpAPI 的 HTTP 状态 */
    if (path === '/api/search-health' && req.method === 'GET') {
      return handleSearchHealth(env);
    }

    /* 证件照存取(KV):注册时上传 → 后台 KYC 审核点开就能看 */
    if (path === '/api/kyc/photo' && (req.method === 'POST' || req.method === 'GET')) {
      return handleKycPhoto(req, env, url);
    }

    /* 用户详情聚合:档案 + 订单 + 总货物/总消费 + 代理奖励,一次拉齐 */
    if (path === '/api/users/detail' && req.method === 'GET') {
      return handleUserDetail(req, env, url);
    }

    /* 全量统计:后台客户名单要显示每个客户的真实订单数/消费额/奖励 */
    if (path === '/api/users/stats' && req.method === 'GET') {
      return handleUsersStats(req, env, url);
    }

    /* 代理奖励同步:把本机的 referredBy / credit / tier 写上云,后台才看得到 */
    if (path === '/api/users/referral' && req.method === 'POST') {
      return handleUserReferral(req, env);
    }

    const dbMatch = path.match(/^\/api\/db\/([a-z_]+)$/);
    if (dbMatch) {
      return handleDb(req, env, dbMatch[1], url);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  }
};

function json(data, status = 200, noStore = false) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  /* 鉴权类响应绝对不能被 CDN 缓存:否则"一次性"链接会被缓存回放 */
  if (noStore) headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
  return new Response(JSON.stringify(data), { status, headers });
}

/* ========== /api/muse ========== */
async function handleMuse(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
  const prompt = (body.prompt || '').trim();
  if (prompt.length < 4) return json({ ok: false, error: 'Prompt too short' }, 400);

  /* 优先 OpenRouter */
  if (env.OPENROUTER_API_KEY) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://okadafrica.com',
          'X-Title': 'OKAD Africa'
        },
        body: JSON.stringify({
          model: 'openai/dall-e-3',
          prompt: prompt,
          n: 1,
          size: '1024x1024'
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        const img = data.data?.[0];
        if (img) {
          return json({
            ok: true,
            image: img.url || ('data:image/png;base64,' + img.b64_json),
            model: 'openai/dall-e-3'
          });
        }
      }
      /* OpenRouter 失败 → 继续走 Pollinations fallback */
    } catch (e) { /* ignore, fallback below */ }
  }

  /* Fallback: Pollinations.ai (免费,无需 API key) */
  try {
    const encoded = encodeURIComponent(prompt);
    const url = 'https://image.pollinations.ai/prompt/' + encoded + '?width=1024&height=1024&nologo=true&seed=' + Date.now();
    return json({
      ok: true,
      image: url,
      model: 'pollinations-ai/flux'
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}
/* ========== /api/search ========== */

/* ── 售卖站白名单 ──────────────────────────────────────────────
   需求:Self Purchase 必须跳到"真正在卖货的网站",不能是词典页/wiki/论坛。
   原来只按查询词搜索,结果里混进 merriam-webster.com/dictionary/buy、
   en.wikipedia.org/wiki/Wholesaling、bestbuy.com 首页 —— 这些一个都不能卖货。
   做法:硬编码允许的域名后缀,不在名单内的一律丢弃。
   ────────────────────────────────────────────────────────── */
const SELLING_HOSTS = [
  /* 中国供应商(优先) */
  'alibaba.com', '1688.com', 'made-in-china.com', 'globalsources.com',
  'aliexpress.com', 'dhgate.com', 'chinagoods.com', 'yiwugo.com',
  'hc360.com', 'ccteg.com', 'cngood.com', 'gongchang.com',
  /* 中国零售/电商 */
  'taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'yangkeduo.com',
  /* 美国 */
  'amazon.com', 'ebay.com', 'walmart.com', 'etsy.com', 'homedepot.com',
  'lowes.com', 'target.com', 'costco.com', 'aliexpress.us',
  'newegg.com', 'besthbuy.com', 'wayfair.com', 'overstock.com', 'temu.com',
  /* 欧洲 */
  'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es',
  'amazon.nl', 'amazon.pl', 'amazon.se', 'amazon.ie', 'amazon.com.be',
  'ebay.co.uk', 'ebay.de', 'ebay.fr', 'ebay.it', 'ebay.es', 'ebay.nl',
  'allegro.pl', 'leboncoin.fr', 'marktplaats.nl', 'idealo.de',
  'otto.de', 'kaufland.de', 'cdiscount.fr', 'fnac.com', 'mediamarkt.de',
  'bol.com', 'emag.ro', 'aliexpress.pl', 'walmart.de', 'argos.co.uk',
  'johnlewis.com', 'currys.co.uk', 'gumtree.com', 'ebay.co.nz', 'ebay.com.au',
];

/* 明显不是售卖站的域名(白名单之外的补充黑名单,防止白名单被泛匹配) */
const BLOCKED_HOST_PATTERNS = [
  /(^|\.)wikipedia\.org$/, /(^|\.)wikimedia\.org$/, /(^|\.)merriam-webster\.com$/,
  /(^|\.)dictionary\.com$/, /(^|\.)dict\.cn$/, /(^|\.)wikiwand\.com$/,
  /(^|\.)facebook\.com$/, /(^|\.)instagram\.com$/, /(^|\.)twitter\.com$/,
  /(^|\.)x\.com$/, /(^|\.)pinterest\./, /(^|\.)reddit\.com$/, /(^|\.)quora\.com$/,
  /(^|\.)youtube\.com$/, /(^|\.)linkedin\.com$/, /(^|\.)tiktok\.com$/,
  /(^|\.)medium\.com$/, /(^|\.)blogspot\./, /(^|\.)wordpress\.com$/,
  /(^|\.)apps\.apple\.com$/, /(^|\.)play\.google\.com$/,
  /(^|\.)google\.com$/, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/,
  /(^|\.)gov$/, /(^|\.)gov\.[a-z]{2}$/, /(^|\.)edu$/, /(^|\.)ac\.uk$/,
  /(^|\.)stackoverflow\.com$/, /(^|\.)quora\.com$/, /(^|\.)tradefairdates\.com$/,
  /(^|\.)diysolarforum\.com$/, /(^|\.)globalspec\.com$/, /(^|\.)alibaba\.com\/$/,
];

/* URL 路径层面的"非商品页"过滤 ——
   光看域名不够:supplier.globalsources.com/login 是登录页,
   made-in-china.com/xxx-Definition-Types 是百科/指南页,
   这些跳过去也买不到东西,必须一并挡掉。 */
const NON_PRODUCT_PATH = [
  /\/login(\.html?|\/)?$/i, /\/signin(\.html?|\/)?$/i, /\/signin\b/i,
  /\/register(\.html?|\/)?$/i, /\/signup(\.html?|\/)?$/i, /\/join(\/)?$/i,
  /\/logout(\.html?|\/)?$/i,
  /\/cart(\/)?$/i, /\/checkout(\/)?$/i, /\/account(\/)?$/i, /\/my\/?$/i,
  /\/help(\/)?$/i, /\/contact(\-us)?(\.html?|\/)?$/i, /\/about(\-us)?(\.html?|\/)?$/i,
  /\/privacy(\.html?|\/)?$/i, /\/terms(\.html?|\/)?$/i, /\/policy(\/)?$/i,
  /\/blog(\/)?$/i, /\/news(\/)?$/i, /\/press(\/)?$/i,
  /-Definition-/i, /\/definition\//i, /\/wiki\//i,
  /\/buyingguides?\//i, /\/guide(\/)?$/i, /\/how-to-/i, /\/insights?\//i
];
/* 判定:是"能直接看商品/供应商的页面",而不是登录页/资讯页 */
function isProductLikeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const path = u.pathname || '/';
  const search = u.search || '';
  /* 极浅路径(只剩 / 或 /xxx/)基本都是首页/频道页 */
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return false;                      /* 首页 */
  if (segs.length === 1 && path.endsWith('/')) return false; /* 频道页 */
  /* Amazon 频道页:/b 结尾但没有 node=/k=/rh= 参数 = 空壳页,点进去什么都没有。
     带 node= 的是真实类目页(能看到商品),放行。 */
  if (/(^|\/)(b|s|gp\/top-sellers)$/i.test(path) &&
      !/(node|k|rh|me|field-keywords)=/i.test(search)) return false;
  for (const re of NON_PRODUCT_PATH) if (re.test(path)) return false;
  return true;
}

function hostAllowed(url) {
  let h;
  try { h = hostOf(url).toLowerCase(); } catch { return false; }
  if (!h) return false;
  for (const b of BLOCKED_HOST_PATTERNS) if (b.test(h)) return false;
  for (const d of SELLING_HOSTS) {
    if (h === d) return true;
    if (h.endsWith('.' + d)) return true;
  }
  return false;
}
/* 完整准入判定:域名白名单 + 路径是商品/供应商页 */
function isSellingProductPage(url) {
  return hostAllowed(url) && isProductLikeUrl(url);
}

/* 站点分组:决定搜索词的构造方式 + 排序权重(中国站优先) */
const SEARCH_TIERS = [
  { key:'alibaba',    label:'Alibaba',         cls:'china',  kw:'alibaba',        hosts:['alibaba.com'],                                    weight:100 },
  { key:'1688',       label:'1688',            cls:'china',  kw:'1688',           hosts:['1688.com'],                                       weight:99 },
  { key:'made_in_china', label:'Made-in-China', cls:'china', kw:'made-in-china', hosts:['made-in-china.com'],                              weight:98 },
  { key:'aliexpress', label:'AliExpress',      cls:'china',  kw:'aliexpress',     hosts:['aliexpress.com'],                                 weight:97 },
  { key:'globalsources', label:'Global Sources', cls:'china', kw:'globalsources', hosts:['globalsources.com'],                             weight:96 },
  { key:'dhgate',     label:'DHgate',          cls:'china',  kw:'dhgate',         hosts:['dhgate.com'],                                     weight:95 },
  { key:'china_supplier', label:'China Supplier', cls:'china', kw:'china supplier', hosts:['hc360.com','ccteg.com','cngood.com','chinagoods.com','yiwugo.com','gongchang.com'], weight:90 },
  { key:'amazon_us',  label:'Amazon US',       cls:'amazon', kw:'amazon.com',     hosts:['amazon.com'],                                     weight:70 },
  { key:'amazon_eu',  label:'Amazon Europe',   cls:'amazon', kw:'amazon europe',  hosts:['amazon.co.uk','amazon.de','amazon.fr','amazon.it','amazon.es','amazon.nl','amazon.pl','amazon.se','amazon.ie','amazon.com.be'], weight:60 },
  { key:'ebay_us',    label:'eBay US',         cls:'amazon', kw:'ebay',           hosts:['ebay.com'],                                       weight:55 },
  { key:'ebay_eu',    label:'eBay Europe',     cls:'amazon', kw:'ebay uk',        hosts:['ebay.co.uk','ebay.de','ebay.fr','ebay.it','ebay.es','ebay.nl'], weight:50 },
];

/* 白名单内、但不属于上面 11 个分组的电商(temu / walmart / jd / 欧洲站等),
   过去 tier 判空就被整条丢弃。现在统一归为 Marketplace 放行 ——
   域名白名单 + 黑名单 + 商品页路径校验仍然全部生效,只是不再要求"必须属于某个分组"。 */
const OTHER_MARKET_TIER = { key:'marketplace', label:'Marketplace', cls:'other', kw:'', hosts:[], weight:40 };

function tierOfHost(url) {
  let h; try { h = hostOf(url).toLowerCase(); } catch { return null; }
  if (!h) return null;
  for (const t of SEARCH_TIERS) {
    for (const d of t.hosts) {
      if (h === d || h.endsWith('.' + d)) return t;
    }
  }
  if (hostAllowed(url)) return OTHER_MARKET_TIER;
  return null;
}

function isImgUrl(u) {
  if (!u || typeof u !== 'string') return false;
  if (!/^https?:\/\//i.test(u)) return false;
  /* 排除占位图 / 追踪像素 / 图标 */
  if (/placeholder|no-image|blank\.gif|spacer|1x1|pixel|transparent|logo|icon|avatar/i.test(u)) return false;
  return true;
}
/* 把标题拆成关键词(去停用词),用于图片匹配 */
function keywords(s) {
  const stop = new Set(['the','a','an','for','and','or','with','in','on','of','to','by','best','new','sale','free','shipping','price','custom','your','buy','from','all','high','quality','product','online','china','wholesale','factory','direct']);
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9一-龥\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 2 && !stop.has(w); });
}
/* 用关键词重合度给图片打分,选最匹配的那张 */
function matchImage(result, imgPool, fallbackIdx, usedSet) {
  if (!imgPool || !imgPool.length) return null;
  usedSet = usedSet || new Set();
  const kw = keywords(result.title);
  const rHost = hostOf(result.url);
  let best = null, bestScore = 0, bestUsed = true;
  for (let i = 0; i < imgPool.length; i++) {
    const im = imgPool[i];
    /* 同域名加分必须用 host 对 host 比较。
       原来拿 im.source(站点名,如 "Made-in-China.com") 去 indexOf(result.url),
       字符串永远匹配不上 → 加分失效 → 全部结果共用第一张图。 */
    const iHost = hostOf(im.link);
    const sameHost = rHost && iHost && (iHost === rHost || rHost.indexOf(iHost) > -1 || iHost.indexOf(rHost) > -1);
    /* 标题关键词:网页标题与图片标题/来源的重叠数 */
    const ikw = keywords(im.title + ' ' + im.source + ' ' + im.link);
    let score = 0;
    for (const k of kw) if (ikw.indexOf(k) > -1) score++;
    if (sameHost) score += 3;
    /* 已被前面结果用过的图片降权,避免多条结果共用同一张图 */
    const used = usedSet.has(i);
    if (used) score -= 2;
    if (score > bestScore || (best === null && !used)) { bestScore = score; best = im; bestUsed = used; }
  }
  /* 一个都没匹配上 → 按序号取一张未被用过的,保证每条都有真实图且不重复 */
  if (!best || (bestUsed && bestScore <= 0)) {
    for (let i = 0; i < imgPool.length; i++) {
      const idx = (fallbackIdx + i) % imgPool.length;
      if (!usedSet.has(idx)) { best = imgPool[idx]; bestScore = 1; break; }
    }
    if (!best) best = imgPool[fallbackIdx % imgPool.length];
  }
  if (best) {
    const at = imgPool.indexOf(best);
    if (at > -1) usedSet.add(at);
  }
  return best;
}
/* 取域名,用于判断图片和网页结果是否同源 */
function hostOf(u) {
  try { return String(u || '').replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, ''); }
  catch { return ''; }
}
/* 搜索结果内存缓存:同一 isolate 跨请求复用,重复/相似查询秒回,
   直接绕开外部接口延迟。Worker isolate 内存不跨实例,仅作边缘预热加速;
   TTL 30 分钟,足够覆盖热门品类的反复搜索。
   ⚠️ key 带版本号:搜索逻辑每次改动都要 +1,否则旧缓存(里面还躺着
   merriam-webster / bestbuy / 登录页 / 百科页这类垃圾链接)会继续被返回。
   v2 = 多源 + 域名白名单;v3 = 再加 URL 路径过滤(挡登录页/百科页/空频道页);
   v4 = 图片链接替换也要过白名单 + 输出前最终去重;
   v5 = 图片池超时放宽 + og:image 兜底(旧缓存里 imageUrl 全空,必须作废);
   v6 = 移除已停用的 Google CSE,备用上游改为 Serper.dev;
   v7 = 备用源扩成 Serper / Tavily / 博查 三级链(旧缓存里躺着 demo 空结果,必须作废)。 */
const _searchCache = new Map();
const _SEARCH_TTL = 30 * 60 * 1000;
function _cacheKey(q, n) { return 'v7|' + (q || '').trim().toLowerCase() + '|' + n; }
function _cacheGet(key) {
  const e = _searchCache.get(key);
  if (e && Date.now() < e.exp) return e.data;
  if (e) _searchCache.delete(key);
  return null;
}
function _cacheSet(key, data, ttlMs) {
  /* 空结果不许覆盖已有的成功结果:上游偶发失败时,避免"刷新一下结果就没了"。
     只有本来就没数据、或显式短缓存的空结果才允许写入。 */
  if (data && data.results && data.results.length === 0) {
    const prev = _cacheGet(key);
    if (prev && prev.results && prev.results.length) return;
  }
  if (_searchCache.size > 200) _searchCache.clear();
  _searchCache.set(key, { exp: Date.now() + (ttlMs || _SEARCH_TTL), data });
}
/* 成功结果只写【内存】缓存,不再写 KV。
   原来每次成功搜索都 await 一次 OTPS.put —— 搜几十次就吃掉几十次
   免费版 1000 次/天 的写入额度;额度一满还会拖慢整个请求。
   内存缓存同一 isolate 内命中率已够用,跨节点复用不值得用每日写入额度换。
   读取侧仍兼容读旧的 KV 缓存(历史数据自然过期),但不再产生新写入。
   空结果一律不缓存,避免把之前的好结果冲掉。
   结果过少(<3 条)只短缓存 5 分钟,否则用户会被锁在差结果里整整 30 分钟。 */
async function cacheSearchResult(key, results, source, env) {
  if (!results || !results.length) return;
  const ttlMs = results.length < 3 ? 5 * 60 * 1000 : _SEARCH_TTL;
  _cacheSet(key, { results: results, source: source }, ttlMs);
}
/* 给 fetch 加超时:超过 ms 毫秒直接 reject,避免被慢上游拖死
   (原来无超时,fetch 可一直挂到运行时上限 → 用户侧体感 30s 卡死)。 */
function fetchWithTimeout(url, opts, ms) {
  return Promise.race([
    fetch(url, opts),
    new Promise(function(_, rej) { setTimeout(function() { rej(new Error('upstream_timeout')); }, ms); })
  ]);
}

/* 抓商品详情页的 og:image / twitter:image —— 图片搜索超时或没匹配上时的兜底。
   商品页几乎都声明了 og:image,比依赖 google_images 稳定得多。
   只读前 150KB,3.5s 超时,任何失败都返回空字符串,绝不拖垮整次搜索。 */
async function fetchOgImage(pageUrl, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ try { ctrl.abort(); } catch(e){} }, ms || 3500);
  try {
    const resp = await fetch(pageUrl, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!resp.ok) return '';
    const ct = resp.headers.get('content-type') || '';
    if (ct && ct.toLowerCase().indexOf('html') < 0) return '';
    const html = (await resp.text()).slice(0, 150000);
    const patterns = [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i,
      /<meta[^>]+itemprop=["']image["'][^>]*content=["']([^"']+)["']/i
    ];
    let raw = '';
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) { raw = m[1]; break; }
    }
    if (!raw) return '';
    raw = raw.replace(/&amp;/g, '&').trim();
    let out;
    if (raw.indexOf('//') === 0) out = 'https:' + raw;
    else if (!/^https?:\/\//i.test(raw)) {
      try { out = new URL(raw, pageUrl).href; } catch { return ''; }
    } else out = raw;
    return isImgUrl(out) ? out : '';
  } catch (e) { return ''; }
  finally { clearTimeout(timer); }
}

/* SerpAPI 配额耗尽(429)后短期熔断:避免每次搜索都先空转打 4 次 429 再回落。
   内存变量只挡单个 isolate,所以同步一份到 KV,让所有边缘节点 10 分钟内
   都直接走备用源。续费后最多 10 分钟自动恢复,无需改代码。 */
let _serpBlockedUntil = 0;
const SERP_BLOCK_KEY = 'serp:blocked';
async function serpBlocked(env) {
  if (Date.now() < _serpBlockedUntil) return true;
  if (!env.OTPS) return false;
  try {
    const v = Number(await env.OTPS.get(SERP_BLOCK_KEY));
    if (v > Date.now()) { _serpBlockedUntil = v; return true; }
  } catch (e) { /* KV 读失败不影响主流程 */ }
  return false;
}
async function markSerpBlocked(env) {
  _serpBlockedUntil = Date.now() + 10 * 60 * 1000;
  /* 熔断标记只放内存:同一 isolate 内生效足够,不值得为它消耗 KV 写入额度 */
}

/* 单次 SerpAPI 网页搜索 —— 只取 organic_results,失败返回空数组(不抛) */
async function serpapiOrganic(query, num, env, ms) {
  try {
    const params = new URLSearchParams({
      engine: 'google', q: query, api_key: env.SERPAPI_KEY, num: String(num)
    });
    const resp = await fetchWithTimeout('https://serpapi.com/search?' + params.toString(), {}, ms || 8000);
    if (!resp.ok) {
      /* 三组并行都会撞 429,只在第一次真正写 KV,避免重复写 */
      if (resp.status === 429 && Date.now() >= _serpBlockedUntil) await markSerpBlocked(env);
      return [];
    }
    const data = await resp.json();
    return data.organic_results || [];
  } catch (e) { return []; }
}

/* SerpAPI google 引擎不吃 site: 语法(实测 site:alibaba.com 会返回
   bestbuy/ebay —— 说明它被当普通词忽略了)。但 "产品词 + 站点名" 能稳定命中,
   所以这里按站点分组并行发多个查询,再合并去重。
   中国站优先 → 美欧站次之,这是 OKAD 的主战场顺序。 */
const SEARCH_GROUP_QUERIES = [
  /* 中国供应商 —— 优先,取前 3 组 */
  { tier:'alibaba',      q: function(k){ return k + ' alibaba'; } },
  { tier:'1688',         q: function(k){ return k + ' 1688 wholesale'; } },
  { tier:'made_in_china',q: function(k){ return k + ' made-in-china supplier'; } },
  { tier:'aliexpress',   q: function(k){ return k + ' aliexpress wholesale'; } },
  { tier:'globalsources',q: function(k){ return k + ' globalsources supplier'; } },
  /* 美欧零售 —— 次之 */
  { tier:'amazon_us',    q: function(k){ return k + ' amazon.com'; } },
  { tier:'amazon_eu',    q: function(k){ return k + ' amazon.co.uk amazon.de amazon.fr'; } },
  { tier:'ebay_us',      q: function(k){ return k + ' ebay.com'; } },
];

/* 清洗单条 organic 结果 */
function cleanOrganic(r) {
  if (!r || !r.link) return null;
  let link = String(r.link);
  if (/google\.com\/(goto|url|aclk)/i.test(link)) return null;
  let title = (r.title && String(r.title).trim()) || '';
  if (/^https?:\/\//i.test(title)) title = '';
  if (/^untitled$/i.test(title)) title = '';
  return {
    title: title,
    url: link,
    snippet: r.snippet || '',
    thumbnail: r.thumbnail || ''
  };
}

/* ========== 备用搜索上游:Serper.dev ==========
   为什么不是 Google CSE:官方已明确 "closed to new customers",且 2027-01-01
   全面关停,新账号根本开不出 customsearch 权限。CSE 那条路是死的,已移除。
   Serper 直接返回 Google 的网页 + 图片结果,注册只需邮箱拿一个 SERPER_API_KEY,
   一次查询只发 2 个请求(网页 + 图片),比 SerpAPI 多组并发便宜得多。
   复用主链路的 cleanOrganic / 域名白名单 / matchImage / og:image,
   保证两条上游给前端的数据结构完全一致。 */
async function serperFetch(path, bodyObj, env, ms) {
  const resp = await fetchWithTimeout('https://google.serper.dev/' + path, {
    method: 'POST',
    headers: {
      'X-API-KEY': env.SERPER_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(bodyObj)
  }, ms || 8000);
  if (!resp.ok) throw new Error('Serper ' + path + ' HTTP ' + resp.status);
  return await resp.json();
}

/* 返回普通数据对象(不是 Response),调用方自行 json(),便于判断 results 长度再决定是否兜底 */
async function serperSearch(query, numResults, env) {
  const kw = String(query)
    .replace(/\s+(wholesale|price|supplier|manufacturer|buy|factory|direct|online)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || query;
  /* 和主链路一样把结果引向中国供应商站,否则会混进词典/百科页 */
  const q = kw + ' alibaba 1688 made-in-china supplier';

  const settled = await Promise.all([
    serperFetch('search', { q: q, num: Math.max(numResults, 10) }, env, 8000).catch(function(){ return null; }),
    serperFetch('images', { q: kw, num: Math.min(numResults * 3, 30) }, env, 8000).catch(function(){ return null; })
  ]);
  /* 两个端点都失败 → 明确标 serper_failed,别和"白名单过滤后零结果"混在一起,便于线上排查 */
  if (!settled[0] && !settled[1]) return { ok: true, results: [], source: 'serper_failed' };

  const organic = (settled[0] && settled[0].organic) || [];
  const imageList = (settled[1] && settled[1].images) || [];

  const imgPool = imageList.map(function(im) {
    return {
      image: im.imageUrl || im.thumbnailUrl || '',
      thumb: im.thumbnailUrl || '',
      source: im.source || '',
      title: im.title || '',
      link: im.link || ''
    };
  }).filter(function(x) { return !!x.image && isImgUrl(x.image); });

  const seen = new Set();
  const merged = [];
  for (const r of organic) {
    const c = cleanOrganic({
      link: r.link, title: r.title, snippet: r.snippet,
      thumbnail: r.imageUrl || ''
    });
    if (!c || !isSellingProductPage(c.url)) continue;
    const tier = tierOfHost(c.url);
    if (!tier) continue;
    let norm;
    try {
      const uu = new URL(c.url);
      norm = uu.hostname.replace(/^www\./i, '') + uu.pathname.replace(/\/$/, '') + uu.search;
    } catch (e) { norm = c.url; }
    if (seen.has(norm)) continue;
    seen.add(norm);
    merged.push({
      title: c.title, url: c.url, snippet: c.snippet, thumbnail: c.thumbnail,
      tier: tier, host: hostOf(c.url).toLowerCase(), weight: tier.weight
    });
  }
  merged.sort(function(a, b) { return b.weight - a.weight; });

  const usedImgs = new Set();
  const results = merged.slice(0, Math.max(numResults, 12)).map(function(r, idx) {
    const img = matchImage({ title: r.title, url: r.url }, imgPool, idx, usedImgs);
    return {
      title: r.title || (img && img.title && img.title.trim()) || r.host,
      url: r.url,
      text: r.snippet || '',
      snippet: r.snippet || '',
      imageUrl: img ? img.image : (r.thumbnail || ''),
      thumbnail: img ? img.thumb : (r.thumbnail || ''),
      imageSource: img ? (img.source || '') : '',
      source: r.tier.label,
      sourceKey: r.tier.key,
      sourceLabel: r.tier.label,
      sourceClass: r.tier.cls,
      host: r.host
    };
  });

  if (!results.length) return { ok: true, results: [], source: 'serper_empty' };

  /* 没配上图的结果走 og:image 兜底,与主链路一致 */
  const ogTargets = [];
  for (let i = 0; i < results.length; i++) if (!results[i].imageUrl) ogTargets.push(i);
  if (ogTargets.length) {
    const ogRes = await Promise.all(ogTargets.slice(0, 8).map(async function(i) {
      return { i: i, u: await fetchOgImage(results[i].url, 3500) };
    }));
    for (const o of ogRes) {
      if (o.u) {
        results[o.i].imageUrl = o.u;
        if (!results[o.i].thumbnail) results[o.i].thumbnail = o.u;
        results[o.i].imageSource = 'og:image';
      }
    }
  }
  return { ok: true, results: results, source: 'serper' };
}

/* ── 备用上游统一归一化 ─────────────────────────────────────────
   Tavily / 博查 的原始结果在这里转成前端统一结构,复用主链路的
   售卖站白名单 / 站点权重 / 配图 / og:image 兜底,保证前端零改动。
   两级准入:先严格(商品详情页),全被过滤时退到"只要是白名单售卖站",
   避免中文搜索源返回站点首页/搜索页时一条都出不来。 */
function _cleanSearchKw(query) {
  return String(query)
    .replace(/\s+(wholesale|price|supplier|manufacturer|buy|factory|direct|online)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || query;
}
async function normalizeAltResults(rows, imgPool, numResults, sourceName, ogOpts) {
  const seen = new Set();
  const pick = function(strict) {
    const out = [];
    seen.clear();
    for (const r of rows) {
      const c = cleanOrganic({
        link: r.url, title: r.title, snippet: r.snippet, thumbnail: r.thumbnail || ''
      });
      if (!c) continue;
      const ok = strict ? isSellingProductPage(c.url) : hostAllowed(c.url);
      if (!ok) continue;
      const tier = tierOfHost(c.url);
      if (!tier) continue;
      let norm;
      try {
        const uu = new URL(c.url);
        norm = uu.hostname.replace(/^www\./i, '') + uu.pathname.replace(/\/$/, '') + uu.search;
      } catch (e) { norm = c.url; }
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({
        title: c.title, url: c.url, snippet: c.snippet, thumbnail: c.thumbnail,
        tier: tier, host: hostOf(c.url).toLowerCase(), weight: tier.weight
      });
    }
    out.sort(function(a, b) { return b.weight - a.weight; });
    return out;
  };
  let merged = pick(true);
  if (!merged.length) merged = pick(false);

  const usedImgs = new Set();
  const results = merged.slice(0, Math.max(numResults, 12)).map(function(r, idx) {
    const img = matchImage({ title: r.title, url: r.url }, imgPool, idx, usedImgs);
    return {
      title: r.title || (img && img.title && img.title.trim()) || r.host,
      url: r.url,
      text: r.snippet || '',
      snippet: r.snippet || '',
      imageUrl: img ? img.image : (r.thumbnail || ''),
      thumbnail: img ? img.thumb : (r.thumbnail || ''),
      imageSource: img ? (img.source || '') : '',
      source: r.tier.label,
      sourceKey: r.tier.key,
      sourceLabel: r.tier.label,
      sourceClass: r.tier.cls,
      host: r.host
    };
  });
  if (!results.length) return { ok: true, results: [], source: sourceName + '_empty' };

  /* 没配上图的结果走 og:image 兜底,与主链路一致。
     Sonar 给的多是分类页,og 命中率低,限制并发与超时避免拖慢整次搜索。 */
  const ogTargets = [];
  for (let i = 0; i < results.length; i++) if (!results[i].imageUrl) ogTargets.push(i);
  if (ogTargets.length) {
    const ogLimit = (ogOpts && ogOpts.limit) || 8;
    const ogMs = (ogOpts && ogOpts.ms) || 3500;
    const ogRes = await Promise.all(ogTargets.slice(0, ogLimit).map(async function(i) {
      return { i: i, u: await fetchOgImage(results[i].url, ogMs) };
    }));
    for (const o of ogRes) {
      if (o.u) {
        results[o.i].imageUrl = o.u;
        if (!results[o.i].thumbnail) results[o.i].thumbnail = o.u;
        results[o.i].imageSource = 'og:image';
      }
    }
  }
  return { ok: true, results: results, source: sourceName };
}

/* ========== 备用搜索上游 2:Tavily ==========
   邮箱验证即可开通、无需信用卡,免费 1000 credits/月(basic 每次 1 credit)。
   include_images 直接返回图片池,省掉一次独立图片搜索。 */

/* 与 SELLING_HOSTS 同源,取最容易出商品页的售卖站。
   只在上游做召回限定,本地黑名单 / 路径过滤 / 白名单一个都不放宽。 */
const TAVILY_INCLUDE_DOMAINS = [
  'alibaba.com', '1688.com', 'made-in-china.com', 'globalsources.com',
  'aliexpress.com', 'dhgate.com', 'chinagoods.com', 'yiwugo.com',
  'amazon.com', 'ebay.com', 'walmart.com', 'temu.com',
  'jd.com', 'taobao.com', 'tmall.com', 'etsy.com',
  'homedepot.com', 'target.com', 'newegg.com', 'wayfair.com',
  'bol.com', 'allegro.pl'
];
async function tavilySearch(query, numResults, env) {
  const kw = _cleanSearchKw(query);
  const q = kw + ' alibaba 1688 made-in-china supplier wholesale product';
  const resp = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.TAVILY_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: q,
      max_results: Math.min(Math.max(numResults, 12), 20),
      search_depth: 'basic',
      include_images: true,
      include_image_descriptions: true,
      include_favicon: false,
      /* 上游先限定在售卖站:否则 Tavily 会回一堆榜单/论坛/厂商官网,
         被本地白名单全丢掉,一次搜索只剩 2 条。 */
      include_domains: TAVILY_INCLUDE_DOMAINS
    })
  }, 12000);  /* 带图请求实测 8.6~8.9s,9s 会压线超时,放宽到 12s */
  if (!resp.ok) throw new Error('Tavily HTTP ' + resp.status);
  const d = await resp.json();
  const rows = (d.results || []).map(function(r) {
    return { title: r.title, url: r.url, snippet: r.content || '', thumbnail: '' };
  });
  const imgPool = (d.images || []).map(function(im) {
    const u = typeof im === 'string' ? im : (im && (im.url || im.image_url || im.src));
    if (!u || !isImgUrl(u)) return null;
    const desc = (typeof im === 'string' ? '' : (im && (im.description || im.title))) || '';
    return { image: u, thumb: u, source: '', title: String(desc).slice(0, 120), link: '' };
  }).filter(Boolean);
  return normalizeAltResults(rows, imgPool, numResults, 'tavily');
}

/* ========== 备用搜索上游 3:博查 AI(国内微信扫码注册) ==========
   国内网络可直连、微信扫码登录、人民币充值;返回 Bing 风格的
   webPages.value[] (name/url/snippet),最适合国内用户注册不了海外服务时用。 */
async function bochaSearch(query, numResults, env) {
  const kw = _cleanSearchKw(query);
  const q = kw + ' 阿里巴巴 1688 中国供应商 批发 产品';
  const resp = await fetchWithTimeout('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.BOCHA_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: q,
      count: Math.min(Math.max(numResults, 12), 20),
      summary: false
    })
  }, 9000);
  if (!resp.ok) throw new Error('Bocha HTTP ' + resp.status);
  const d = await resp.json();
  const wp = (d && d.webPages) || (d && d.data && d.data.webPages) || {};
  const value = wp.value || [];
  const rows = value.map(function(r) {
    return {
      title: r.name || r.title || '',
      url: r.url,
      snippet: r.snippet || r.summary || '',
      thumbnail: ''
    };
  });
  return normalizeAltResults(rows, [], numResults, 'bocha');
}

/* ========== 备用搜索上游 4:OpenRouter / Perplexity Sonar(零注册) =========
   线上已配置 OPENROUTER_API_KEY(/api/muse 在用),无需再注册任何账号或绑卡。
   Sonar 自带联网检索,让它吐结构化商品页 JSON;模型给的链接一律要过
   售卖站白名单,防止编造 URL 把客户带到错网站。按 token 计费,约 $0.005~0.01/次,
   且受搜索缓存保护。想彻底关闭:wrangler secret put SONAR_SEARCH 填 0。 */
async function sonarSearch(query, numResults, env) {
  const kw = _cleanSearchKw(query);
  const sys = 'You are a B2B product sourcing assistant. Return ONLY a JSON array, no markdown, no prose. '
           + 'Each element: {"title":string,"url":string,"snippet":string}. '
           + 'Only real product or supplier URLs on alibaba.com, 1688.com, made-in-china.com, '
           + 'aliexpress.com, dhgate.com, globalsources.com, amazon.com, ebay.com. '
           + 'Prefer concrete product-detail pages over category / showroom / countrysearch pages. Never invent URLs.';
  const usr = 'Find up to ' + Math.min(Math.max(numResults, 12), 20)
            + ' real product listing pages for "' + kw
            + '" from Chinese wholesale suppliers (alibaba / 1688 / made-in-china). Return JSON array only.';
  const resp = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://okadafrica.com',
      'X-Title': 'OKAD Africa'
    },
    body: JSON.stringify({
      model: 'perplexity/sonar',
      max_tokens: 1200,
      temperature: 0.2,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: usr } ]
    })
  }, 15000);
  if (!resp.ok) throw new Error('Sonar HTTP ' + resp.status);
  const d = await resp.json();
  const content = (d && d.choices && d.choices[0] && d.choices[0].message
    ? (d.choices[0].message.content || '') : '');
  let rows = [];
  try { rows = JSON.parse(content); } catch (e) {
    const s = content.indexOf('['), t = content.lastIndexOf(']');
    if (s > -1 && t > s) { try { rows = JSON.parse(content.slice(s, t + 1)); } catch (e2) {} }
  }
  if (!Array.isArray(rows)) rows = [];
  rows = rows.filter(function(r) {
    return r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url);
  }).map(function(r) {
    return {
      title: String(r.title || '').slice(0, 160),
      url: r.url,
      snippet: String(r.snippet || '').slice(0, 300),
      thumbnail: ''
    };
  });
  /* citations 是模型真实检索到的页面,补进候选,提高命中率 */
  const cites = (d && Array.isArray(d.citations)) ? d.citations : [];
  for (const c of cites) {
    const u = typeof c === 'string' ? c : (c && c.url);
    if (u && /^https?:\/\//i.test(u) && !rows.some(function(r) { return r.url === u; })) {
      rows.push({ title: '', url: u, snippet: '', thumbnail: '' });
    }
  }
  return normalizeAltResults(rows, [], numResults, 'sonar', { limit: 4, ms: 2000 });
}

/* 按"已配置"顺序依次尝试所有备用源,返回第一个有结果的。
   任何一个没配 key 就自动跳过,因此未配置时线上行为与改造前完全一致。
   全挂也返回 ok:true 空结果让前端走 demo,绝不 502。 */
async function tryFallbacks(query, numResults, env) {
  const chain = [];
  if (env.SERPER_API_KEY) chain.push(['serper', function(){ return serperSearch(query, numResults, env); }]);
  if (env.TAVILY_API_KEY)  chain.push(['tavily', function(){ return tavilySearch(query, numResults, env); }]);
  if (env.BOCHA_API_KEY)   chain.push(['bocha',  function(){ return bochaSearch(query, numResults, env); }]);
  if (env.OPENROUTER_API_KEY && env.SONAR_SEARCH !== '0') {
    chain.push(['sonar', function(){ return sonarSearch(query, numResults, env); }]);
  }
  let last = null;
  for (const pair of chain) {
    const name = pair[0];
    try {
      const r = await pair[1]();
      if (r && r.results && r.results.length) return r;
      last = r || { ok: true, results: [], source: name + '_empty' };
    } catch (e) {
      last = { ok: true, results: [], source: name + '_failed', error: String(e && e.message || e).slice(0, 120) };
    }
  }
  return last || { ok: true, results: [], source: 'none' };
}

async function handleSearch(req, env, ctx) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const query = (body.query || '').trim();
  const numResults = Math.min(parseInt(body.numResults) || 10, 20);

  if (!query) return json({ ok: false, error: 'Missing query' }, 400);

  /* 缓存命中 → 秒回,彻底绕开外部接口延迟。
     L1: 同 isolate 内存(快,但不跨边缘);L2: KV 全局缓存(跨节点复用)。 */
  const _key = _cacheKey(query, numResults);
  const _mem = _cacheGet(_key);
  if (_mem) return json(Object.assign({ ok: true, cached: 'memory' }, _mem));
  if (env.OTPS) {
    try {
      const _kv = await env.OTPS.get('search:' + _key);
      if (_kv) {
        const _d = JSON.parse(_kv);
        /* 只认有结果的缓存:历史遗留的空结果不许把用户卡在 demo 上 */
        if (_d && _d.results && _d.results.length) {
          _cacheSet(_key, _d);
          return json(Object.assign({ ok: true, cached: 'kv' }, _d));
        }
      }
    } catch (e) { /* KV 读失败不影响主流程 */ }
  }

  /* 优先 SerpAPI —— 多源并行。429 配额耗尽期间(内存 + KV 双读)熔断,
     所有边缘节点都直接落到下面的备用源,不再空转打 4 次 429 */
  const _blocked = await serpBlocked(env);
  /* SerpAPI 额度已耗尽(429),默认停用,避免每个新 isolate 先空转打一次失败请求。
     key 保留着:额度恢复后只需在 Worker 环境加 SERPAPI_ENABLED=1 即可重新启用,不用改代码。 */
  if (env.SERPAPI_ENABLED === '1' && env.SERPAPI_KEY && !_blocked) {
    try {
      /* 原来只发一次通用查询("关键词 + wholesale price supplier manufacturer buy"),
         结果里混进 merriam-webster 词典页 / bestbuy 首页 / wikipedia —— 
         这些一个都不能卖货,Self Purchase 跳过去等于废了。
         现在改成:按站点分组并行发查询(产品词 + 站点名),
         再用域名白名单过滤,只剩真正的售卖站。 */

      /* 提取纯产品词:前端传来的 query 里可能带了 "wholesale price supplier buy" 之类后缀,
         这里剥掉,避免 "buy" 这种词命中词典页。 */
      const kw = String(query)
        .replace(/\s+(wholesale|price|supplier|manufacturer|buy|factory|direct|online)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim() || query;

      /* 降本:SerpAPI 按「搜索次数」计费。原来一次点击并发 8 组 organic
         + 1 组 google_images = 9 次扣费,用户点 11 下就烧掉 100 次额度。
         现在只发前 3 组中国供应商(OKAD 主战场),每组 num 6→8 补足结果量,
         一次点击 9 次 → 4 次。美欧零售组保留定义,暂时不并发。 */
      const runGroup = function(g) {
        return serpapiOrganic(g.q(kw), 8, env, 8000).then(function(list) {
          return { tier: g.tier, list: list };
        });
      };
      const settled = await Promise.all(SEARCH_GROUP_QUERIES.slice(0, 3).map(runGroup));

      /* 图片池:只发一次图片搜索,给所有结果配图 */
      let imgPool = [];
      try {
        const ip = new URLSearchParams({
          engine: 'google_images', q: kw, api_key: env.SERPAPI_KEY,
          num: String(Math.min(numResults * 3, 30))
        });
        /* 原来 5s 太短:google_images 常在第 6~8 秒才返回,
           超时后整个图片池被丢弃 → 12 条结果 imageUrl 全空 → 前端全是首字母占位。
           放宽到 8s,与 organic 查询同量级;真超时还有下面 og:image 兜底。 */
        const ir = await Promise.race([
          fetch('https://serpapi.com/search?' + ip.toString()).catch(function(){ return null; }),
          new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('img_timeout')); }, 8000); })
        ]);
        if (ir && ir.ok) {
          const idata = await ir.json();
          const imgs = idata.images_results || idata.image_results || [];
          if (imgs.length) {
            imgPool = imgs.map(function(im) {
              let t = im.title || im.source_title || im.snippet || im.alt || '';
              if (/^https?:\/\//i.test(String(t))) t = '';
              if (!t && im.link) {
                try {
                  const seg = String(im.link).split('?')[0].split('/').filter(Boolean).pop() || '';
                  t = decodeURIComponent(seg).replace(/[-_]+/g,' ').replace(/\.(jpg|jpeg|png|webp)$/i,'');
                } catch(e) {}
              }
              return {
                image: im.original || im.thumbnail || '',
                thumb: im.thumbnail || '',
                source: im.source || im.origin || '',
                title: t,
                link: im.link || ''
              };
            }).filter(function(x) { return !!x.image; });
          }
        }
      } catch (ie) { /* 图片搜索失败不影响网页结果 */ }

      /* 合并所有分组的结果 → 白名单过滤 → 按站点权重排序 → 去重 */
      const seen = new Set();
      const merged = [];
      for (const grp of settled) {
        for (const r of grp.list) {
          const c = cleanOrganic(r);
          if (!c) continue;
          const host = hostOf(c.url).toLowerCase();
          /* 白名单:不是售卖站的一律丢弃 —— 这就是"跳过去全是错网站"的根治点。
             再加一道路径校验,挡掉登录页 / 百科页 / 购买指南页。 */
          if (!isSellingProductPage(c.url)) continue;
          /* 分组 tier 与实际域名不一致时,以实际域名为准(查询可能带出别站) */
          const tier = tierOfHost(c.url);
          if (!tier) continue;
          /* 去重:必须忽略协议和主机前缀差异。原来只截 '#' 和末位 '/',
             amazon.com/xxx/b?ie=UTF8 这种同一路径两条重复仍会漏进来。 */
          let norm;
          try {
            const uu = new URL(c.url);
            norm = uu.hostname.replace(/^www\./i, '') + uu.pathname.replace(/\/$/, '') + uu.search;
          } catch (e) { norm = c.url; }
          if (seen.has(norm)) continue;
          seen.add(norm);
          merged.push({
            title: c.title, url: c.url, snippet: c.snippet, thumbnail: c.thumbnail,
            tier: tier.key, tierLabel: tier.label, tierCls: tier.cls,
            weight: tier.weight, host: host
          });
        }
      }
      /* 中国站优先 → 同权重按站点固定顺序 */
      merged.sort(function(a, b) { return b.weight - a.weight; });

      /* 配图 + 标题兜底 */
      const usedImgs = new Set();
      const results = merged.slice(0, Math.max(numResults, 12)).map(function(r, idx) {
        const img = matchImage({ title: r.title, url: r.url }, imgPool, idx, usedImgs);
        const iHost = hostOf(img && img.link);
        const sameSite = img && iHost && r.host && (iHost === r.host || r.host.indexOf(iHost) > -1 || iHost.indexOf(r.host) > -1);
        let title = r.title || '';
        if (!title) title = (img && img.title && img.title.trim()) || '';
        if (!title) {
          try {
            const seg = String(r.url).split('?')[0].split('/').filter(Boolean).pop() || '';
            const slug = decodeURIComponent(seg).replace(/[-_]+/g, ' ').replace(/\.(html?|php|jsp|aspx)$/i, '').trim();
            if (slug && slug.length > 2 && !/^\d+$/.test(slug)) title = slug;
          } catch(e) {}
        }
        if (!title) title = r.host;
        /* 图片链接可能指向更具体的商品页,但它是"未过滤"的地址 ——
           直接用会绕开白名单(实测就是它把 made-in-china 的百科页放了进来),
           而且两条结果可能匹配同一张图 → 输出重复 URL。
           所以:替换前必须先过一遍同样的准入校验,不过就用原来的网页链接。 */
        let url = r.url;
        if (sameSite && img && img.link && isSellingProductPage(img.link)) url = img.link;
        return {
          title: title,
          url: url,
          text: r.snippet || '',
          snippet: r.snippet || '',
          imageUrl: img ? img.image : (r.thumbnail || ''),
          thumbnail: img ? img.thumb : (r.thumbnail || ''),
          imageSource: img ? (img.source || iHost) : '',
          source: r.tierLabel,
          sourceKey: r.tier,
          sourceLabel: r.tierLabel,
          sourceClass: r.tierCls,
          host: r.host
        };
      });

      /* 最终去重:上面 url 可能被替换成图片链接(两条结果可能撞同一张图),
         所以输出前再按最终 url 归一去重一次。 */
      const finalSeen = new Set();
      const results2 = [];
      for (const r of results) {
        let k;
        try {
          const uu = new URL(r.url);
          k = uu.hostname.replace(/^www\./i, '') + uu.pathname.replace(/\/$/, '') + uu.search;
        } catch (e) { k = r.url; }
        if (finalSeen.has(k)) continue;
        finalSeen.add(k);
        results2.push(r);
      }

      /* ── og:image 兜底 ───────────────────────────────────────────
         google_images 超时 / 没匹配上图的结果,直接去抓商品页的
         og:image。并发抓前 8 条、每条 3.5s 超时,失败只影响那一条。
         这是「搜索结果一张图都没有」的最后一道保险。 */
      const ogTargets = [];
      for (let i = 0; i < results2.length; i++) {
        if (!results2[i].imageUrl) ogTargets.push(i);
      }
      if (ogTargets.length) {
        const ogRes = await Promise.all(ogTargets.slice(0, 8).map(async function(i) {
          return { i: i, u: await fetchOgImage(results2[i].url, 3500) };
        }));
        for (const o of ogRes) {
          if (o.u) {
            results2[o.i].imageUrl = o.u;
            if (!results2[o.i].thumbnail) results2[o.i].thumbnail = o.u;
            results2[o.i].imageSource = 'og:image';
          }
        }
      }

      if (!results2.length) {
        /* 一个售卖站都没命中 → 依次试所有已配置的备用源,不给前端垃圾链接。
           零结果短缓存必须等兜底也失败才写:否则兜底成功前的几秒里,
           并发请求会命中空缓存,出现「第一次有结果、刷新就没了」。 */
        const fb = await tryFallbacks(query, numResults, env);
        if (fb.results && fb.results.length) {
          await cacheSearchResult(_key, fb.results, fb.source, env);
          return json(fb);
        }
        /* 主链路 + 兜底全空 → 才短缓存 5 分钟,避免反复空转烧额度 */
        _cacheSet(_key, { results: [], source: 'no_selling_site' }, 5 * 60 * 1000);
        /* debug 只在「零结果」时返回,便于线上快速判断是上游没数据
           还是白名单过滤太严,前端不会用到这个字段。 */
        return json({
          ok: true, results: [], source: 'no_selling_site',
          note: 'No selling-site result found, showing demo results.',
          debug: {
            serpKey: !!env.SERPAPI_KEY,
            groups: settled.map(function(g){ return g.tier + ':' + (g.list || []).length; }),
            imgPool: imgPool.length,
            ogTried: ogTargets.length,
            fallback: fb.source
          }
        });
      }

      const _payload = { results: results2, source: 'serpapi_multi' };
      await cacheSearchResult(_key, results2, 'serpapi_multi', env);
      return json(Object.assign({ ok: true }, _payload));
    } catch (e) {
      /* SerpAPI 慢/挂:不直接 502。依次试所有已配置备用源,都没有就空结果(前端走 demo),绝不挂死 */
      const fb = await tryFallbacks(query, numResults, env);
      if (fb.results && fb.results.length) {
        await cacheSearchResult(_key, fb.results, fb.source, env);
        return json(fb);
      }
      _cacheSet(_key, { results: [], source: 'serpapi_failed' }, 5 * 60 * 1000);
      return json({ ok: true, results: [], source: 'serpapi_failed', note: 'Live search temporarily unavailable, showing demo results.', fallback: fb.source });
    }
  }

  /* 没配 SerpAPI(或 429 熔断中)→ 直接走备用源链:Serper / Tavily / 博查 / Sonar */
  if (env.SERPER_API_KEY || env.TAVILY_API_KEY || env.BOCHA_API_KEY ||
      (env.OPENROUTER_API_KEY && env.SONAR_SEARCH !== '0')) {
    const fb = await tryFallbacks(query, numResults, env);
    if (fb.results && fb.results.length) {
      await cacheSearchResult(_key, fb.results, fb.source, env);
    } else {
      /* 备用源也空:短缓存 5 分钟,别让每次刷新都重打一遍 9 秒的 Sonar */
      _cacheSet(_key, { results: [], source: fb.source || 'fallback_empty' }, 5 * 60 * 1000);
    }
    return json(fb);
  }

  /* 无搜索 API 配置:返回空结果,前端自动 fallback 到 mock */
  return json({ ok: true, results: [], source: 'none', note: 'No search API configured. Add SERPAPI_KEY / SERPER_API_KEY / TAVILY_API_KEY / BOCHA_API_KEY to enable live search.' });
}

/* OpenRouter key 有效性探测 —— /api/v1/auth/key 是免费端点,不消耗额度,
   也不返回密钥内容。顺带能定位「/api/muse 图片没生成」是不是密钥失效。 */
async function probeOpenRouterKey(env) {
  if (!env.OPENROUTER_API_KEY) return { configured: false };
  try {
    const r = await fetchWithTimeout('https://openrouter.ai/api/v1/auth/key', {
      headers: { 'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY }
    }, 6000);
    return { configured: true, valid: r.ok, status: r.status };
  } catch (e) {
    return { configured: true, valid: false, status: 0 };
  }
}

/* 搜索上游自检 —— 线上排查「搜索没结果」时用,不暴露任何密钥 */
async function handleSearchHealth(env) {
  const keys = {
    serpapi: !!(env.SERPAPI_KEY && env.SERPAPI_ENABLED === '1'),
    serper:  !!env.SERPER_API_KEY,
    tavily:  !!env.TAVILY_API_KEY,
    bocha:   !!env.BOCHA_API_KEY,
    sonar:   !!(env.OPENROUTER_API_KEY && env.SONAR_SEARCH !== '0')
  };
  const order = ['serpapi', 'serper', 'tavily', 'bocha', 'sonar'];
  const active = order.find(function(k) { return keys[k]; }) || 'none';
  const out = {
    serpKey: keys.serpapi, serper: keys.serper,
    tavily: keys.tavily, bocha: keys.bocha, sonar: keys.sonar,
    active: active,
    cseRetired: 'Google CSE closed to new customers, shuts down 2027-01-01',
    openrouter: await probeOpenRouterKey(env)
  };
  if (active === 'none') {
    return json(Object.assign({ ok: false, error: 'No search key (SERPAPI_KEY / SERPER_API_KEY / TAVILY_API_KEY / BOCHA_API_KEY / OPENROUTER_API_KEY)' }, out));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ try { ctrl.abort(); } catch(e){} }, 12000);
  try {
    let r, txt, count = 0, err = null;
    if (active === 'serpapi') {
      const params = new URLSearchParams({
        engine: 'google', q: 'phone accessories alibaba',
        api_key: env.SERPAPI_KEY, num: '3'
      });
      r = await fetch('https://serpapi.com/search?' + params.toString(), { signal: ctrl.signal });
      txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch (e) {}
      count = d && d.organic_results ? d.organic_results.length : 0;
      err = d && d.error ? d.error : null;
    } else if (active === 'serper') {
      r = await fetch('https://google.serper.dev/search', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'phone accessories alibaba', num: 3 })
      });
      txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch (e) {}
      count = d && d.organic ? d.organic.length : 0;
      err = d && (d.error || d.message) ? (d.error || d.message) : null;
    } else if (active === 'tavily') {
      r = await fetch('https://api.tavily.com/search', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Authorization': 'Bearer ' + env.TAVILY_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'phone accessories alibaba', max_results: 3, search_depth: 'basic' })
      });
      txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch (e) {}
      count = d && d.results ? d.results.length : 0;
      err = d && d.detail ? String(d.detail).slice(0, 120) : null;
    } else if (active === 'sonar') {
      /* 不额外打一次付费 chat 请求:openrouter 字段已经探过 key 有效性 */
      return json(Object.assign({}, out, {
        ok: out.openrouter.valid, status: out.openrouter.status, probed: 'sonar',
        organic: 0,
        error: out.openrouter.valid ? null : 'OpenRouter key invalid (also affects /api/muse)',
        body: ''
      }));
    } else {
      r = await fetch('https://api.bochaai.com/v1/web-search', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Authorization': 'Bearer ' + env.BOCHA_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'phone accessories 阿里巴巴 供应商', count: 3 })
      });
      txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch (e) {}
      count = d && d.webPages && d.webPages.value ? d.webPages.value.length : 0;
      err = d && (d.message || d.error) ? String(d.message || d.error).slice(0, 120) : null;
    }
    return json(Object.assign({}, out, {
      ok: r.ok, status: r.status, probed: active,
      /* SerpAPI 配额耗尽时,实际兜底到哪个源,避免 health 看着像"搜索全挂" */
      effective: (r.status === 429 && keys.sonar) ? 'sonar' : active,
      organic: count, error: err, body: txt.slice(0, 240)
    }));
  } catch (e) {
    return json(Object.assign({}, out, { ok: false, error: String(e) }));
  } finally { clearTimeout(timer); }
}

/* ========== /api/img — 商品图代理 ==========
   为什么需要:SerpAPI/og:image 给的是第三方 CDN 直链,浏览器直接加载时
   会撞上三类问题 —— ① 站点检查 Referer 防盗链(返回 403 或占位图);
   ② https 页面加载 http 图片被浏览器按混合内容拦截;
   ③ 部分 CDN 对 no-referrer 请求直接拒绝。
   走 Worker 转发后统一是 https + 我们自己的域,并且带上图片所在站的
   Referer,命中率明显提高。同时禁止内网地址,避免被当 SSRF 用。 */
async function handleImageProxy(url) {
  const target = url.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) return new Response('Bad url', { status: 400 });
  let u;
  try { u = new URL(target); } catch { return new Response('Bad url', { status: 400 }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return new Response('Bad scheme', { status: 400 });

  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost = h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1'
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^169\.254\./.test(h) || h.endsWith('.internal') || h.endsWith('.local')
    || h.endsWith('.localhost');
  if (privateHost) return new Response('Forbidden host', { status: 403 });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(function(){ try { ctrl.abort(); } catch(e){} }, 8000);
    let upstream;
    try {
      upstream = await fetch(target, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          /* 防盗链关键:把 Referer 伪装成图片所在站点 */
          'Referer': u.protocol + '//' + u.host + '/'
        },
        cf: { cacheEverything: true, cacheTtl: 86400 }
      });
    } finally { clearTimeout(timer); }

    if (!upstream.ok) return new Response('Upstream ' + upstream.status, { status: 502 });
    const ct = upstream.headers.get('content-type') || '';
    if (!/^image\//i.test(ct)) return new Response('Not an image', { status: 502 });
    const buf = await upstream.arrayBuffer();
    if (!buf || buf.byteLength < 100) return new Response('Empty image', { status: 502 });
    if (buf.byteLength > 8 * 1024 * 1024) return new Response('Image too large', { status: 502 });
    return new Response(buf, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (e) {
    return new Response('Proxy error: ' + String(e), { status: 502 });
  }
}

/* ========== /api/config ========== */
function handleConfig(env) {
  return json({
    ok: true,
    config: {
      whatsapp: {
        number: env.WHATSAPP_NUMBER || '233505615533',
        text: env.WHATSAPP_TEXT || 'Hello OKAD AFRICA',
        label: env.WHATSAPP_LABEL || 'Chat on WhatsApp'
      },
      contact: {
        hours: env.CONTACT_HOURS || 'Mon–Fri 09:00–18:00 GMT'
      },
      referral: {
        title: env.REF_TITLE || 'Share OKAD & Earn $10',
        desc: env.REF_DESC || 'Invite friends — they get $10 off first order',
        code: env.REF_CODE || 'OKAD-NEW10',
        reward: env.REF_REWARD || '$10'
      },
      worker_url: env.WORKER_URL || 'https://api.okadafrica.com'
    }
  });
}

/* ========== /api/payment  支付信息(收款账号)========== */
/* 存在 D1 config 表,key = 'payment'。管理员保存 → 上云;客户打开支付页 → 拉云。
   没写进云端之前,收款账号只存在管理员本机浏览器里,客户永远看不到改动。 */
const PAYMENT_CONFIG_KEY = 'payment';

/* 云端没有记录时返回的兜底值 —— 与前端 DEFAULT_PAYMENT_INFO 保持一致 */
function paymentDefaults() {
  return {
    momo: { active: true, name: 'Mobile Money (MTN / M-Pesa / Airtel / Orange)', number: '+86 138-0000-0000', country: 'Pan-Africa', note: 'Send to Mobile Money wallet · Include order ID in transfer note', qrUrl: '' },
    bank: { active: true, bankName: 'Bank of China', accountName: 'OKAD AFRICA Logistics Ltd.', accountNo: '1234 5678 9012 3456', swift: 'BKCHCNBJ45A', bankAddr: 'Shanghai Branch, China', currency: 'USD', note: 'Include order ID · SWIFT fees borne by sender' },
    usdt: { active: true, network: 'TRC20', address: 'TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', qrUrl: '', explorer: 'https://tronscan.org/#/address/', note: 'Send only TRC20 USDT to this address · Include order ID in memo', rate: '1 USDT = 1 USD' }
  };
}

async function handlePaymentGet(req, env) {
  if (!env.DB) {
    /* 没配 D1 就退回默认值,别让支付页整个挂掉 */
    return json({ ok: true, payment: paymentDefaults(), source: 'default' });
  }
  try {
    const row = await env.DB.prepare('SELECT data FROM config WHERE key = ?').bind(PAYMENT_CONFIG_KEY).first();
    if (row && row.data) {
      let parsed = null;
      try { parsed = JSON.parse(row.data); } catch (e) { parsed = null; }
      if (parsed && parsed.momo) {
        return json({ ok: true, payment: parsed, source: 'cloud' });
      }
    }
    return json({ ok: true, payment: paymentDefaults(), source: 'default' });
  } catch (e) {
    /* config 表可能还没建 —— 静默兜底 */
    return json({ ok: true, payment: paymentDefaults(), source: 'default' });
  }
}

async function handlePaymentSave(req, env) {
  if (!env.DB) return json({ ok: false, error: 'DB not configured' }, 503);

  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const info = body && body.payment ? body.payment : body;
  if (!info || typeof info !== 'object') {
    return json({ ok: false, error: 'payment payload required' }, 400);
  }
  /* 基本结构校验:必须有 momo/bank/usdt 至少一项,否则是前端 bug */
  if (!info.momo && !info.bank && !info.usdt) {
    return json({ ok: false, error: 'Invalid payment payload' }, 400);
  }
  /* 只保留白名单字段,避免把奇怪的东西塞进配置表 */
  const clean = { momo: {}, bank: {}, usdt: {} };
  const FIELDS = {
    momo: ['active', 'name', 'number', 'country', 'note', 'qrUrl'],
    bank: ['active', 'bankName', 'accountName', 'accountNo', 'swift', 'bankAddr', 'currency', 'note'],
    usdt: ['active', 'network', 'address', 'qrUrl', 'explorer', 'note', 'rate']
  };
  for (const grp of Object.keys(FIELDS)) {
    const src = info[grp] || {};
    for (const f of FIELDS[grp]) {
      if (src[f] === undefined || src[f] === null) continue;
      clean[grp][f] = (f === 'active') ? (src[f] ? 1 : 0) : String(src[f]).slice(0, 500);
    }
  }

  try {
    await env.DB.prepare(
      'INSERT INTO config (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data'
    ).bind(PAYMENT_CONFIG_KEY, JSON.stringify(clean)).run();
    return json({ ok: true, saved: true, payment: clean });
  } catch (e) {
    /* 老库没有 config 表 → 建表再试一次 */
    try {
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, data TEXT NOT NULL)'
      ).run();
      await env.DB.prepare(
        'INSERT INTO config (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data'
      ).bind(PAYMENT_CONFIG_KEY, JSON.stringify(clean)).run();
      return json({ ok: true, saved: true, payment: clean });
    } catch (e2) {
      return json({ ok: false, error: e2.message }, 500);
    }
  }
}

/* ========== OTP: 发送 / 校验 / Brevo 投递 ========== */
const OTP_TTL = 900;        /* 验证码 15 分钟有效 —— 必须与三语言前端文案一致 */
const OTP_COOLDOWN = 900;   /* 发码后 15 分钟内同一收件人【一律不再发第二封】。
                               冷却期 == 有效期,整个窗口只发一封:前端按钮锁死,后端也拒绝。
                               记在云端 KV,清浏览器缓存 / 换设备 / curl 直调都绕不过。 */
const OTP_DAILY_MAX = 5;    /* 同一邮箱每天最多 5 封,防跨窗口慢速刷爆 Brevo 300封/天 */

/* 发码冷却的 isolate 内存兜底:KV 免费额度打满时 put 会失败(10048),
   若只靠 KV 冷却,额度一满反而变成「随便发」。这层内存至少保证同一边缘节点
   15 分钟内不重复发,且零 KV 写入。跨节点仍靠云端 cd: 键。 */
const _otpSentMem = new Map();

async function handleSendOtp(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok:false, error:'Invalid JSON' }, 400); }

  /* 兼容旧版:旧前端只发 { email },新版发 { channel, to } */
  const channel = (body.channel === 'whatsapp') ? 'whatsapp' : 'email';
  const to = (body.to || body.email || body.phone || '').trim().toLowerCase();
  if (!to) return json({ ok:false, error:'Missing recipient' }, 400);

  if (!storeOk(env)) return json({ ok:false, error:'Verification store not configured' }, 503);

  /* 先查发信通道有没有配好 —— 放在防刷检查之前,否则没配 key 时用户只看到 429,根本不知道真正原因 */
  if (channel === 'email' && !env.BREVO_API_KEY) {
    return json({ ok:false, error:'BREVO_API_KEY not configured' }, 503);
  }

  /* ── 15 分钟硬冷却:整个有效期内只发一封 ─────────────────────────────
     以前前端「没收到?重新发送」会带 force=true 绕过冷却、作废旧码再发一封,
     这正是邮件爆量 + KV 写入爆量的源头。现在 force 参数彻底废弃:
     无论带不带 force,冷却期内一律不发信,只回报「已发送 + 剩余秒数」。
     冷却记在云端 KV(清浏览器缓存/换设备/直调 API 都绕不过),
     再加一层 isolate 内存兜底:KV 写失败时同一个边缘节点也不会重复发。 */
  const otpKey = 'otp:' + channel + ':' + to;
  const cdKey  = 'cd:'  + channel + ':' + to;
  const cdRaw  = await storeGet(env, cdKey).catch(function(){ return null; });
  let sentAt = 0;
  try { sentAt = _otpSentMem.get(to) || 0; } catch (e) { sentAt = 0; }
  if (!sentAt && cdRaw) sentAt = parseInt(cdRaw, 10) || 0;
  if (sentAt && (Date.now() - sentAt) < OTP_COOLDOWN * 1000) {
    const left = Math.max(1, Math.ceil((sentAt + OTP_COOLDOWN * 1000 - Date.now()) / 1000));
    const existing = await storeGet(env, otpKey).catch(function(){ return null; });
    if (existing) {
      /* 旧码还在:复用,不发信;前端据此校正倒计时 */
      return json({ ok:true, sent:false, alreadySent:true, expiresIn: left, channel });
    }
    /* 码已被校验消耗(客人刚登录)但冷却未过:同样不重发 */
    return json({ ok:false, error:'Please wait 15 minutes before requesting another code', retryAfter: left }, 429);
  }

  /* 每日硬上限:跨窗口慢速刷(每小时几封)也挡得住 */
  const dayKey = 'otpday:' + channel + ':' + to + ':' + new Date().toISOString().slice(0, 10);
  const dayCount = parseInt(await storeGet(env, dayKey) || '0', 10);
  if (dayCount >= OTP_DAILY_MAX) {
    return json({ ok:false, error:'Daily code limit reached (5). Please contact support.' }, 429);
  }

  /* WhatsApp 通道尚未开通,提前返回,别白白写 3 个 KV 键 */
  if (channel === 'whatsapp') {
    return json({ ok:false, error:'WhatsApp channel not enabled yet' }, 502);
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const now = Date.now();

  /* ── 关键顺序:先落验证码,再发邮件 ──────────────────────────────
     KV 免费额度打满(10048)时 put 会失败。若「先发信后落库」,客户会收到
     一封永远校验不了的码,反复点就反复收信 —— 正是「不要一直发」要挡的。
     先写失败就直接 503,一封邮件都不发,零副作用、零写入配额消耗。 */
  if(!await storePut(env, otpKey, code, { expirationTtl: OTP_TTL })){
    return json({ ok:false, error:'Verification storage is busy. Please try again in a minute.' }, 503);
  }
  /* 冷却键存时间戳(不是 '1'),这样重复请求能算出精确剩余秒数 */
  await storePut(env, cdKey, String(now), { expirationTtl: OTP_COOLDOWN });
  await storePut(env, dayKey, String(dayCount + 1), { expirationTtl: 86400 });

  /* isolate 内存兜底:同一边缘节点内即使 KV 冷却键写入失败也不重复发 */
  try { _otpSentMem.set(to, now); } catch (e) {}

  const sent = await sendEmailOtp(to, code, env);
  if (!sent.ok) {
    /* 邮件没发出去:整笔发码事务回滚 —— 验证码、冷却键、日计数、内存占位全清。
       只删验证码是不够的,残留的 cd: 会把客人误锁 15 分钟,日上限还白扣一次。 */
    try { _otpSentMem.delete(to); } catch (e) {}
    await storeDel(env, otpKey);
    await storeDel(env, cdKey);
    await storeDel(env, dayKey);
    return json({ ok:false, error: sent.error }, 502);
  }

  /* 关键:不要把 code 回给前端 */
  return json({ ok:true, sent:true, channel, expiresIn: OTP_TTL });
}

async function handleVerifyOtp(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok:false, error:'Invalid JSON' }, 400); }

  const channel = (body.channel === 'whatsapp') ? 'whatsapp' : 'email';
  const to = (body.to || body.email || body.phone || '').trim().toLowerCase();
  const code = (body.code || '').toString().trim();
  if (!to || !code) return json({ ok:false, error:'Missing recipient or code' }, 400);

  if (!storeOk(env)) return json({ ok:false, error:'Verification store not configured' }, 503);

  const key = 'otp:' + channel + ':' + to;
  const real = await storeGet(env, key);
  if (!real) return json({ ok:false, error:'Code expired or never requested' });
  if (real !== code) return json({ ok:false, error:'Wrong code' });

  await storeDel(env, key);      /* 一次性,用完即焚 */
  return json({ ok:true, verified:true });
}

/* Brevo 账号里唯一已验证的发件人。okadafrica.com 未做域名验证(SPF/DKIM),
   用它发信 Brevo 也会接单(201),但收件方大概率丢进垃圾箱 —— 默认走已验证邮箱,
   等 okadafrica.com 在 Brevo 后台验证完成后再把 MAIL_FROM 改成 noreply@okadafrica.com */
const DEFAULT_MAIL_FROM = 'sammy71777@gmail.com';

/* Brevo 免费版:300 封/天,永久免费 */
async function sendEmailOtp(to, code, env) {
  if (!env.BREVO_API_KEY) return { ok:false, error:'BREVO_API_KEY not configured' };
  if (!to.includes('@')) return { ok:false, error:'Invalid email' };

  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'OKAD Africa', email: env.MAIL_FROM || DEFAULT_MAIL_FROM },
        to: [{ email: to }],
        subject: 'Your OKAD verification code',
        htmlContent: '<p>Your OKAD verification code is:</p>'
          + '<p style="font-size:28px;font-weight:700;letter-spacing:4px">' + code + '</p>'
          + '<p>Valid for 5 minutes. If you did not request this, ignore this email.</p>'
      })
    });
    if (!resp.ok) {
      const txt = (await resp.text()).slice(0, 300);
      return { ok:false, error:'Brevo ' + resp.status + ': ' + txt };
    }
    return { ok:true };
  } catch (e) {
    return { ok:false, error:'Brevo request failed: ' + e.message };
  }
}

/* 物流进度通知邮件 —— 与 OTP 验证码共用 Brevo 通道与发件人，不引入新组件 */
async function sendNotifyEmail(to, subject, html, env) {
  if (!env.BREVO_API_KEY) return { ok:false, error:'BREVO_API_KEY not configured' };
  if (!to || !to.includes('@')) return { ok:false, error:'Invalid email' };
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'OKAD Africa', email: env.MAIL_FROM || DEFAULT_MAIL_FROM },
        to: [{ email: to }],
        subject: subject || 'OKAD AFRICA shipment update',
        htmlContent: html || '<p>Shipment update from OKAD AFRICA.</p>'
      })
    });
    if (!resp.ok) {
      const txt = (await resp.text()).slice(0, 300);
      return { ok:false, error:'Brevo ' + resp.status + ': ' + txt };
    }
    return { ok:true };
  } catch (e) {
    return { ok:false, error:'Brevo request failed: ' + e.message };
  }
}

/* ========== /api/notify/email ==========
   后台推进物流节点后，把进度直接发到客户邮箱（客户无需主动查单） */
async function handleNotifyEmail(req, env) {
  let body = {};
  try { body = await req.json(); } catch (e) { return json({ ok:false, error:'Invalid JSON' }, 400); }
  const to = String(body.to || '').trim().toLowerCase();
  const code = String(body.code || '').trim().toUpperCase().slice(0, 40);
  const action = String(body.action || '').trim().toLowerCase();
  const loc = String(body.loc || '').trim().slice(0, 120);
  if (!to.includes('@')) return json({ ok:false, error:'Invalid email' }, 400);
  if (!code) return json({ ok:false, error:'Missing order code' }, 400);

  /* 主题与正文一律由 Worker 按白名单动作生成。
     原来前端直接传 subject + html,任何人都能拿这个端点当免费群发通道 ——
     现在外部传不进自定义内容,追踪链接也由 Worker 自己拼,不受外部控制。 */
  const LABELS = {
    payconfirm: { en:'Payment confirmed', zh:'付款已确认' },
    shipped:    { en:'Shipped / departed', zh:'货物已发出' },
    delivered:  { en:'Delivered', zh:'货物已签收' },
    manual:     { en:'Shipment update', zh:'物流更新' }
  };
  const lb = LABELS[action];
  if (!lb) return json({ ok:false, error:'Invalid action' }, 400);
  const esc = function(s){ return String(s).replace(/[&<>"']/g, ''); };
  const safeCode = esc(code);
  const safeLoc = esc(loc);
  const trackLink = 'https://okadafrica.com/?track=' + encodeURIComponent(safeCode);
  const subject = 'OKAD ' + safeCode + ' · ' + lb.zh + ' / ' + lb.en;
  const html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:20px">'
    + '<div style="background:#0B2545;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">'
      + '<div style="font-size:16px;font-weight:800">OKAD AFRICA · 物流更新</div>'
      + '<div style="font-size:12px;opacity:.85;margin-top:2px">Shipment update</div></div>'
    + '<div style="border:1px solid #E5E7EB;border-top:0;padding:18px 20px;border-radius:0 0 12px 12px">'
      + '<div style="font-size:12px;color:#6B7280">订单号 / Order</div>'
      + '<div style="font-size:18px;font-weight:800;color:#0B2545;margin:2px 0 14px">' + safeCode + '</div>'
      + '<div style="font-size:12px;color:#6B7280">最新状态 / Status</div>'
      + '<div style="font-size:15px;font-weight:700;color:#059669;margin:2px 0 10px">' + lb.zh + ' / ' + lb.en + '</div>'
      + (safeLoc ? '<div style="background:#FFF7ED;border-left:3px solid #F97316;padding:10px 12px;border-radius:6px;font-size:13px;color:#9A3412;margin-bottom:14px;line-height:1.5">📍 ' + safeLoc + '</div>' : '')
      + '<a href="' + trackLink + '" style="display:inline-block;background:#F97316;color:#fff;text-decoration:none;padding:11px 22px;border-radius:22px;font-size:13px;font-weight:800">查看实时进度 / Track now</a>'
      + '<div style="font-size:11px;color:#9CA3AF;margin-top:14px;line-height:1.6">This is an automated shipment update from OKAD AFRICA.<br>Questions? Reply to this email or WhatsApp us.</div>'
    + '</div></div>';
  const r = await sendNotifyEmail(to, subject, html, env);
  return json(r, r.ok ? 200 : 502);
}

/* ========== /api/exchange-rates ========== */
async function handleFx(req, env, ctx) {
  const cache = caches.default;
  const cached = await cache.match(req);
  if (cached) {
    const d = await cached.json();
    return json({ ok: true, cached: true, ...d });
  }

  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await resp.json();
    if (data.result !== 'success') throw new Error('API error');

    const result = {
      ok: true,
      base: 'USD',
      rates: data.rates,
      ts: Date.now(),
      source: 'open.er-api.com'
    };

    ctx.waitUntil(cache.put(req, new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })));

    return json(result);
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

/* ========== /api/db/{table} ========== */
async function handleDb(req, env, table, url) {
  if (!env.DB) return json({ ok: false, error: 'DB not configured' }, 503);

  /* wa_login_requests:WhatsApp 一次性登录请求,后台需要查看 / 清理 */
  const validTables = ['users', 'orders', 'cooperation', 'inquiries', 'kyc_logs', 'fx_snapshots', 'wa_login_requests'];
  if (!validTables.includes(table)) {
    return json({ ok: false, error: 'Invalid table' }, 400);
  }

  try {
    /* GET:支持 Supabase 风格过滤 ?id=eq.OKAD123 / ?status=eq.Paid,以及 ?order=col.desc / ?limit=N
       此前无条件 SELECT * 全表:前端 getOrderById() 取 rows[0],拿到的其实是"表里第一行",
       客户用公司代码查单会查到别人的单(或查不到)。 */
    if (req.method === 'GET') {
      const raw = url.searchParams;
      const filters = [];
      const values = [];
      for (const [k, v] of raw.entries()) {
        if (k === 'limit' || k === 'order') continue;
        /* 列名白名单,杜绝 SQL 注入 */
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        let val = String(v);
        const m = val.match(/^(eq|neq|gt|gte|lt|lte|like|ilike)\.(.+)$/i);
        if (m) {
          if (/^neq$/i.test(m[1])) continue;          /* neq 不能直接映射成 = */
          val = m[2];
        }
        filters.push(k + ' = ?');
        values.push(val);
      }

      let orderBy = '';
      const ord = raw.get('order');
      if (ord) {
        const [col, dir] = String(ord).split('.');
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(col || '')) {
          orderBy = ' ORDER BY ' + col + ' ' + (/^desc$/i.test(dir || '') ? 'DESC' : 'ASC');
        }
      }
      const lim = parseInt(raw.get('limit') || '', 10);
      const limitSql = (Number.isFinite(lim) && lim > 0) ? ' LIMIT ' + Math.min(lim, 500) : '';

      const base = 'SELECT * FROM ' + table + (filters.length ? ' WHERE ' + filters.join(' AND ') : '');
      let results;
      try {
        ({ results } = await env.DB.prepare(base + orderBy + limitSql).bind(...values).all());
      } catch (e) {
        /* 排序列可能不存在(前端历史写法 order=created_at.desc,而表里是 createdTs) — 去掉排序重试 */
        if (orderBy) ({ results } = await env.DB.prepare(base + limitSql).bind(...values).all());
        else throw e;
      }
      /* users 表:密码哈希/盐绝不能下发到前端(否则任何人都能拿到哈希做离线爆破) */
      if (table === 'users' && results && results.length) {
        results = results.map(function (r) {
          const c = Object.assign({}, r);
          delete c.password_hash;
          delete c.password_salt;
          return c;
        });
      }
      return json({ ok: true, rows: results });
    }

    if (req.method === 'POST') {
      const body = await req.json();

      /* users 表特例:前端 DB.upsertUser() 只带档案列(email/name/phone/kyc...),
         而 Worker 这里是 INSERT OR REPLACE —— 未指定的列会被写回默认值 NULL。
         结果就是「用户登录 → 同步档案」会把已设的密码哈希抹掉。
         所以写入前把服务端持有的密码列回填,保证密码不被清。
         同理:代理奖励列与证件照标记也必须回填,
         否则客户每登录一次,后台看到的推荐/奖励就归零了。 */
      if (table === 'users') {
        const em = String(body.email || '').trim().toLowerCase();
        if (em) {
          try {
            const old = await env.DB.prepare(
              'SELECT password_hash, password_salt, pw_set_at, device_id, referred_by, credit_balance, ref_tier, ref_invites, ref_gifters, has_id_photo, total_spent, order_count FROM users WHERE lower(trim(email)) = ? LIMIT 1'
            ).bind(em).all();
            const o = (old.results && old.results[0]) || null;
            if (o) {
              if (body.password_hash === undefined && o.password_hash) body.password_hash = o.password_hash;
              if (body.password_salt === undefined && o.password_salt) body.password_salt = o.password_salt;
              if (body.pw_set_at    === undefined && o.pw_set_at)      body.pw_set_at    = o.pw_set_at;
              if (body.device_id    === undefined && o.device_id)      body.device_id    = o.device_id;
              /* 奖励与统计列:前端没带就别覆盖 */
              const keep = ['referred_by', 'credit_balance', 'ref_tier', 'ref_invites', 'ref_gifters', 'has_id_photo', 'total_spent', 'order_count'];
              for (const k of keep) {
                if (body[k] === undefined && o[k] !== null && o[k] !== undefined) body[k] = o[k];
              }
            }
          } catch (e) { /* 密码列尚未创建 → 忽略,首次设密码时会 ALTER 补上 */ }
        }
      }

      const keys = Object.keys(body);
      const placeholders = keys.map(() => '?').join(',');
      const sql = 'INSERT OR REPLACE INTO ' + table + ' (' + keys.join(',') + ') VALUES (' + placeholders + ')';
      await env.DB.prepare(sql).bind(...keys.map(k => body[k])).run();
      return json({ ok: true, inserted: true });
    }

    /* DELETE:必须带过滤条件,禁止裸 DELETE(防止误删全表)
       支持前端 Supabase 风格过滤: email=eq.foo@bar.com / id=eq.xxx */
    if (req.method === 'DELETE') {
      const raw = url.searchParams;
      const filters = [];
      const values = [];
      for (const [k, v] of raw.entries()) {
        if (k === 'limit' || k === 'order') continue;
        let val = String(v);
        /* 剥掉 Supabase 风格操作符前缀 eq./neq./like. 等 */
        const m = val.match(/^(eq|neq|gt|gte|lt|lte|like|ilike)\.(.+)$/i);
        if (m) val = m[2];
        if (m && /^neq$/i.test(m[1])) continue;      /* neq 不能直接映射成 = */
        /* 列名白名单:只允许字母数字下划线,杜绝 SQL 注入 */
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        filters.push(k + ' = ?');
        values.push(val);
      }
      if (!filters.length) {
        return json({ ok: false, error: 'DELETE requires at least one filter (e.g. ?email=eq.foo@bar.com)' }, 400);
      }
      const sql = 'DELETE FROM ' + table + ' WHERE ' + filters.join(' AND ');
      await env.DB.prepare(sql).bind(...values).run();
      return json({ ok: true, deleted: true, filters: filters.length });
    }

    return json({ ok: false, error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ==================================================================
   /api/auth/*  —— 6 位数字密码登录 + 免密会话
   业务规则(按需求):
     1) 登录成功后 10 分钟内再次进入 → 不需要重新输入密码
     2) 超过 10 分钟,但「同一个 IP + 同一个设备」→ 仍然免密(静默续期)
     3) 换设备 或 换 IP → 必须重新输入密码
   安全:
     · 密码不落明文:PBKDF2-SHA256 + 每用户随机 salt,存 D1 users 表
     · 在线爆破防护:KV 计数,10 分钟内失败 10 次锁定 10 分钟
   ================================================================== */
const PWD_FREE_WINDOW = 10 * 60 * 1000;   /* 10 分钟免密窗口 */
const PWD_MAX_FAIL    = 10;               /* 10 分钟内最多失败次数 */
const PWD_ITER        = 20000;            /* PBKDF2 迭代(控制在 Worker CPU 限额内) */

function clientIp(req) {
  const v = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || '';
  return String(v).split(',')[0].trim();
}
function emailKey(e) { return String(e || '').trim().toLowerCase(); }
function hexToBytes(h) {
  const out = new Uint8Array(Math.floor(String(h || '').length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(String(h).substr(i * 2, 2), 16) || 0;
  return out;
}
function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
  return s;
}
async function pbkdf2(pw, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : new Uint8Array(0);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: PWD_ITER, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}
/* users 表惰性加列(列已存在时 ALTER 报错,直接忽略) */
async function ensurePwdCols(env) {
  if (!env.DB) return;
  const cols = [['password_hash', 'TEXT'], ['password_salt', 'TEXT'], ['pw_set_at', 'INTEGER'], ['device_id', 'TEXT']];
  for (const [c, t] of cols) {
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN ' + c + ' ' + t).run(); } catch (e) { /* 已存在 */ }
  }
}

/* 代理奖励 + 证件照标记列(同样惰性加列) */
async function ensureRewardCols(env) {
  if (!env.DB) return;
  const cols = [
    ['referred_by', 'TEXT'],
    ['credit_balance', 'INTEGER'],
    ['ref_tier', 'TEXT'],
    ['ref_invites', 'INTEGER'],
    ['ref_gifters', 'INTEGER'],
    ['has_id_photo', 'INTEGER'],
    ['total_spent', 'INTEGER'],
    ['order_count', 'INTEGER']
  ];
  for (const [c, t] of cols) {
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN ' + c + ' ' + t).run(); } catch (e) { /* 已存在 */ }
  }
}
async function getUserByEmail(env, email) {
  if (!env.DB) return null;
  try {
    const r = await env.DB.prepare('SELECT * FROM users WHERE lower(trim(email)) = ? LIMIT 1').bind(email).all();
    return (r.results && r.results[0]) || null;
  } catch (e) { return null; }
}

/* ==================================================================
   /api/kyc/photo —— 客户证件照存取(KV)
   为什么放 KV 不放 D1:
     · base64 图片几十 KB~几百 KB,塞进 D1 行里会把 users 表撑爆
     · KV 单值 25MB,图片存 KV 最合适;D1 只留 has_id_photo 标记位
   Key 规则: kyc:<小写邮箱>
   ================================================================== */
const KYC_PHOTO_PREFIX = 'kyc:';

async function handleKycPhoto(req, env, url) {
  try {
    await ensureRewardCols(env);

    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const em = emailKey(body.email);
      if (!em) return json({ ok: false, error: 'Email required' }, 400);

      let photo = String(body.photo || '');
      if (!photo) {
        /* 空 = 客户撤回照片 */
        await kvDel(env, KYC_PHOTO_PREFIX + em);
        try {
          await env.DB.prepare('UPDATE users SET has_id_photo = 0 WHERE lower(trim(email)) = ?').bind(em).run();
        } catch (e) {}
        return json({ ok: true, cleared: true });
      }
      /* 只接受 image/* 的 data URL,防止塞任意东西 */
      if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(photo)) {
        return json({ ok: false, error: 'photo must be an image data URL' }, 400);
      }
      /* 体积上限 3MB(base64),超了直接拒绝,别把 KV 撑爆 */
      if (photo.length > 3 * 1024 * 1024) {
        return json({ ok: false, error: 'photo too large (max 3MB)' }, 413);
      }
      if(!await kvPut(env, KYC_PHOTO_PREFIX + em, photo)){
        return json({ ok: false, error: 'Photo storage is busy. Please try again in a minute.' }, 503);
      }
      try {
        await env.DB.prepare('UPDATE users SET has_id_photo = 1 WHERE lower(trim(email)) = ?').bind(em).run();
      } catch (e) { /* 用户行还没建好也没关系,后台上传前会再刷一次 */ }
      return json({ ok: true, saved: true, bytes: photo.length });
    }

    /* GET:后台点开看证件照 */
    const em = emailKey(url.searchParams.get('email'));
    if (!em) return json({ ok: false, error: 'Email required' }, 400);
    let photo = null;
    try { photo = await env.OTPS.get(KYC_PHOTO_PREFIX + em); } catch (e) {}
    return json({ ok: true, hasPhoto: !!photo, photo: photo || null });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ==================================================================
   /api/users/detail —— 用户详情聚合
   一次把后台要的都给齐,避免前端来回拉:
     档案(users 表) + 订单(D1 orders,按 email 或手机号归一匹配)
     + 总货物(件数/重量) + 总消费(金额) + 代理奖励(credit/tier/邀请数)
   订单归属兼容:customerPhone / waPhone / phone / email,取后 9 位归一
   ================================================================== */
function normPhone(p) {
  const s = String(p || '').replace(/\D+/g, '');
  if (!s) return '';
  /* 加纳/西非号码:去掉国家码与前导 0,取后 9 位 */
  if (s.length > 9) return s.slice(-9);
  return s;
}

async function handleUserDetail(req, env, url) {
  try {
    await ensureRewardCols(env);
    const em = emailKey(url.searchParams.get('email'));
    const phRaw = String(url.searchParams.get('phone') || '').trim();
    if (!em && !phRaw) return json({ ok: false, error: 'email or phone required' }, 400);

    /* 1) 档案 */
    let user = null;
    if (em) user = await getUserByEmail(env, em);
    if (!user && phRaw) {
      try {
        const r = await env.DB.prepare('SELECT * FROM users WHERE replace(phone," ","") LIKE ? LIMIT 1')
          .bind('%' + phRaw.replace(/\D/g, '').slice(-9)).all();
        user = (r.results && r.results[0]) || null;
      } catch (e) {}
    }
    if (!user) return json({ ok: false, error: 'User not found' }, 404);

    /* 2) 订单:把该用户所有订单捞出来(notes 里是完整订单 JSON) */
    const wantEmail = emailKey(user.email);
    const wantPhone = normPhone(user.phone);
    let rows = [];
    try {
      const r = await env.DB.prepare('SELECT * FROM orders ORDER BY createdTs DESC LIMIT 500').all();
      rows = r.results || [];
    } catch (e) { rows = []; }

    const mine = [];
    for (const r of rows) {
      let full = {};
      try { full = JSON.parse(r.notes || '{}'); } catch (e) { full = {}; }
      const cand = [
        full.customerPhone, full.waPhone, full.phone, full.contactPhone,
        r.email, full.email, full.customerEmail
      ];
      let hit = false;
      for (const c of cand) {
        if (!c) continue;
        if (wantEmail && emailKey(c) === wantEmail) { hit = true; break; }
        const nc = normPhone(c);
        if (wantPhone && nc && nc === wantPhone) { hit = true; break; }
      }
      if (!hit && user.name && full.customer && String(full.customer) === String(user.name)) hit = true;
      if (!hit) continue;

      mine.push({
        id: r.id,
        code: full.id || r.id,
        product: full.product || r.product || '',
        qty: Number(full.qty || r.qty || 0),
        wt: Number(full.wt || 0),
        vol: Number(full.vol || 0),
        route: full.route || r.route || '',
        method: full.method || r.method || '',
        status: full.status || r.status || '',
        total: Number(full.totalUSD || full.quote || full.cost || r.total || 0),
        cost: Number(full.cost || 0),
        profit: Number(full.profit || 0),
        date: full.date || (r.createdTs ? new Date(r.createdTs).toISOString() : ''),
        source: full.source || ''
      });
    }

    /* 3) 统计:总货物(件数/重量) + 总消费 */
    let totalQty = 0, totalWt = 0, totalVol = 0, totalSpent = 0, totalProfit = 0;
    for (const o of mine) {
      totalQty += o.qty || 0;
      totalWt += o.wt || 0;
      totalVol += o.vol || 0;
      totalSpent += o.total || 0;
      totalProfit += o.profit || 0;
    }

    /* 4) 代理奖励:优先用库里同步过来的值,没有就用邀请关系现场算 */
    let referrals = [];
    try {
      const r = await env.DB.prepare('SELECT email, name, phone, referred_by, credit_balance, ref_tier, ref_invites, ref_gifters FROM users WHERE referred_by IS NOT NULL AND referred_by != "" LIMIT 300').all();
      referrals = r.results || [];
    } catch (e) { referrals = []; }

    const myReferralKey = String(user.phone || user.email || '');
    let invites = Number(user.ref_invites || 0);
    let gifters = Number(user.ref_gifters || 0);
    let credit = Number(user.credit_balance || 0);
    let tier = user.ref_tier || 't0';

    if (!invites && myReferralKey) {
      const matched = referrals.filter(function (r) {
        return String(r.referred_by || '') === myReferralKey ||
               emailKey(r.referred_by) === emailKey(myReferralKey);
      });
      invites = matched.length;
      gifters = matched.filter(function (r) { return Number(r.credit_balance || 0) > 0; }).length;
    }
    if (!tier || tier === 't0') {
      const t = tierOf(invites, gifters);
      tier = t.id;
    }

    /* 5) 写回统计(后台看到的就是真数字,不是写死的 0) */
    try {
      await env.DB.prepare(
        'UPDATE users SET total_spent = ?, order_count = ?, ref_invites = ?, ref_gifters = ?, credit_balance = ?, ref_tier = ? WHERE lower(trim(email)) = ?'
      ).bind(
        Math.round(totalSpent), mine.length, invites, gifters, credit, tier, emailKey(user.email)
      ).run();
    } catch (e) { /* 更新失败不影响返回 */ }

    return json({
      ok: true,
      user: {
        name: user.name || '', email: user.email || '', phone: user.phone || '',
        id: user.id || '', idType: user.id_type || user.idType || '',
        country: user.country || '', ip: user.ip || '',
        kycStatus: user.kyc_status || user.kycStatus || 'pending',
        kycReason: user.kyc_reason || user.kycReason || '',
        kycTs: user.kyc_ts || user.kycTs || 0,
        kycBy: user.kyc_by || user.kycBy || '',
        regTs: user.regTs || user.reg_ts || 0,
        hasIdPhoto: !!user.has_id_photo || Number(user.has_id_photo || 0) === 1
      },
      orders: mine,
      stats: {
        orderCount: mine.length,
        totalQty: totalQty,
        totalWt: Math.round(totalWt * 100) / 100,
        totalVol: Math.round(totalVol * 100) / 100,
        totalSpent: Math.round(totalSpent * 100) / 100,
        totalProfit: Math.round(totalProfit * 100) / 100
      },
      referral: {
        invites: invites, gifters: gifters, credit: credit, tier: tier,
        tierName: tierOf(invites, gifters).name,
        reward: tierOf(invites, gifters).credit
      }
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ==================================================================
   /api/users/stats —— 全量客户统计(后台客户名单用)
   admin 本机通常没有订单数据,不在这里聚合的话名单上永远是
   "0 orders · $0"。所以按 email 从 orders 表聚合,再合并奖励列。
   ================================================================== */
async function handleUsersStats(req, env, url) {
  try {
    await ensureRewardCols(env);

    let userRows = [];
    try {
      const r = await env.DB.prepare(
        'SELECT email, credit_balance, ref_tier, has_id_photo, referred_by, order_count, total_spent FROM users LIMIT 1000'
      ).all();
      userRows = r.results || [];
    } catch (e) { userRows = []; }

    /* 按邮箱聚合订单(orders.email 是小写写入的) */
    const aggMap = {};
    try {
      const r = await env.DB.prepare(
        "SELECT lower(trim(email)) AS em, COUNT(*) AS n, "
        + "SUM(COALESCE(total,0)) AS spent, SUM(COALESCE(qty,0)) AS qty "
        + "FROM orders WHERE email IS NOT NULL AND trim(email) != '' GROUP BY lower(trim(email))"
      ).all();
      for (const a of (r.results || [])) {
        if (a && a.em) aggMap[a.em] = { n: Number(a.n || 0), spent: Number(a.spent || 0), qty: Number(a.qty || 0) };
      }
    } catch (e) { /* orders 表异常就只返回奖励列 */ }

    const rows = userRows.map(function (u) {
      const em = emailKey(u.email);
      const a = aggMap[em] || { n: 0, spent: 0, qty: 0 };
      /* 统计列只在有人点过详情时才写,没写就用订单表现算的 */
      const oc = (u.order_count != null && Number(u.order_count) > 0) ? Number(u.order_count) : a.n;
      const ts = (u.total_spent != null && Number(u.total_spent) > 0) ? Number(u.total_spent) : a.spent;
      return {
        email: u.email || '',
        orderCount: oc,
        totalSpent: Math.round(ts * 100) / 100,
        totalQty: a.qty,
        creditBalance: Number(u.credit_balance || 0),
        refTier: u.ref_tier || 't0',
        referredBy: u.referred_by || '',
        hasIdPhoto: Number(u.has_id_photo || 0) === 1
      };
    });
    return json({ ok: true, rows: rows });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* 等级判定(与前端 REFERRAL_TIERS 保持一致) */
const REFERRAL_TIERS_W = [
  { id: 't1', name: 'Friend', minInvites: 1, minGifters: 0, credit: 5 },
  { id: 't2', name: 'Connector', minInvites: 3, minGifters: 0, credit: 20 },
  { id: 't3', name: 'Ambassador', minInvites: 5, minGifters: 1, credit: 50 },
  { id: 't4', name: 'Legend', minInvites: 10, minGifters: 3, credit: 150 }
];
function tierOf(invites, gifters) {
  let cur = { id: 't0', name: 'New', credit: 0 };
  for (const t of REFERRAL_TIERS_W) {
    if (invites >= t.minInvites && gifters >= t.minGifters) cur = t;
  }
  return cur;
}

/* ==================================================================
   /api/users/referral —— 代理奖励数据上云
   之前这套机制只存在本机 localStorage,后台看不到、换设备就丢。
   这里把它写进 users 表,后台与其它设备都能读到。
   ================================================================== */
async function handleUserReferral(req, env) {
  try {
    await ensureRewardCols(env);
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
    const em = emailKey(body.email);
    if (!em) return json({ ok: false, error: 'Email required' }, 400);

    const u = await getUserByEmail(env, em);
    if (!u) return json({ ok: false, error: 'User not registered yet' }, 404);

    const referredBy = body.referredBy != null ? String(body.referredBy || '') : (u.referred_by || '');
    const credit = Number(body.credit || 0);
    const tier = String(body.tier || 't0');
    const invites = Number(body.invites || 0);
    const gifters = Number(body.gifters || 0);

    /* 只更新这几个字段,绝不能整行 REPLACE(会抹掉密码哈希/证件照标记) */
    try {
      await env.DB.prepare(
        'UPDATE users SET referred_by = ?, credit_balance = ?, ref_tier = ?, ref_invites = ?, ref_gifters = ? WHERE lower(trim(email)) = ?'
      ).bind(referredBy, credit, tier, invites, gifters, em).run();
    } catch (e) { return json({ ok: false, error: e.message }, 500); }
    return json({ ok: true, synced: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function handleAuth(req, env, path, url) {
  const jx = (d, st) => json(d, st || 200, true);   /* 鉴权响应禁止 CDN 缓存 */
  const ip = clientIp(req);
  let body = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { return jx({ ok: false, error: 'Invalid JSON' }, 400); }
  }
  const email = emailKey(body.email || url.searchParams.get('email'));
  const deviceId = String(body.deviceId || url.searchParams.get('deviceId') || '').slice(0, 64);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jx({ ok: false, error: 'Valid email required' }, 400);
  }

  /* ---------- 查询:是否已设密码 / 当前设备是否免密 ---------- */
  if (path === '/api/auth/status' && req.method === 'GET') {
    const u = await getUserByEmail(env, email);
    const has = !!(u && u.password_hash);
    let trusted = false, reason = '';
    if (has && storeOk(env) && deviceId) {
      const sess = await storeGet(env, 'auth:' + email, { type: 'json' });
      if (sess && sess.deviceId === deviceId) {
        if (Date.now() - (sess.ts || 0) < PWD_FREE_WINDOW) { trusted = true; reason = 'within-10min'; }
        else if (sess.ip && sess.ip === ip) { trusted = true; reason = 'same-ip-device'; }
      }
    }
    return jx({
      ok: true, hasPassword: has, trusted: trusted, reason: reason,
      pwSetAt: (u && u.pw_set_at) ? Number(u.pw_set_at) : 0
    });
  }

  /* ---------- 设置 / 修改密码 ---------- */
  if (path === '/api/auth/set-password' && req.method === 'POST') {
    const pw = String(body.password || '');
    if (!/^\d{6}$/.test(pw)) return jx({ ok: false, error: 'Password must be exactly 6 digits' }, 400);
    if (!env.DB) return jx({ ok: false, error: 'DB not configured' }, 503);
    const u = await getUserByEmail(env, email);
    if (!u) return jx({ ok: false, error: 'Email not registered. Please register first.' }, 404);
    await ensurePwdCols(env);
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await pbkdf2(pw, salt);
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, password_salt = ?, pw_set_at = ?, device_id = ? WHERE lower(trim(email)) = ?'
    ).bind(hash, salt, Date.now(), deviceId || (u.device_id || ''), email).run();
    /* 设完密码 = 本机已通过验证 → 直接开免密会话(写不进去也要返回成功,密码已入库) */
    await storePut(env, 'auth:' + email, JSON.stringify({ ip: ip, deviceId: deviceId, token: '', ts: Date.now() }));
    return jx({ ok: true, set: true, pwSetAt: Date.now() });
  }

  /* ---------- 密码登录 ---------- */
  if (path === '/api/auth/login' && req.method === 'POST') {
    const pw = String(body.password || '');
    if (!/^\d{6}$/.test(pw)) return jx({ ok: false, error: 'Password must be exactly 6 digits' }, 400);
    if (!env.DB) return jx({ ok: false, error: 'DB not configured' }, 503);

    if (storeOk(env)) {
      const f = parseInt((await storeGet(env, 'pwfail:' + email)) || '0', 10);
      if (f >= PWD_MAX_FAIL) {
        return jx({ ok: false, error: 'Too many wrong attempts. Please wait a few minutes or log in with an email code.' }, 429);
      }
    }
    const u = await getUserByEmail(env, email);
    if (!u || !u.password_hash) return jx({ ok: false, error: 'No password set for this account yet' }, 404);
    const calc = await pbkdf2(pw, u.password_salt || '');
    if (calc !== String(u.password_hash)) {
      if (storeOk(env)) {
        const f = parseInt((await storeGet(env, 'pwfail:' + email)) || '0', 10);
        await storePut(env, 'pwfail:' + email, String(f + 1), { expirationTtl: 600 });
        return jx({ ok: false, error: 'Wrong password', triesLeft: Math.max(0, PWD_MAX_FAIL - f - 1) }, 401);
      }
      return jx({ ok: false, error: 'Wrong password' }, 401);
    }

    let token = '';
    if (storeOk(env)) {
      token = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      await storeDel(env, 'pwfail:' + email);
      await storePut(env, 'auth:' + email, JSON.stringify({ ip: ip, deviceId: deviceId, token: token, ts: Date.now() }));
    }
    return jx({ ok: true, token: token, ts: Date.now(), ttl: PWD_FREE_WINDOW });
  }

  /* ---------- 静默续期:10 分钟内 或 同 IP + 同设备 ---------- */
  if (path === '/api/auth/refresh' && req.method === 'POST') {
    if (!storeOk(env)) return jx({ ok: false, error: 'Session store not configured' }, 503);
    const sess = await storeGet(env, 'auth:' + email, { type: 'json' });
    if (!sess) return jx({ ok: false, error: 'No active session', need: 'password' }, 401);
    if (deviceId && sess.deviceId && sess.deviceId !== deviceId) {
      return jx({ ok: false, error: 'Different device', need: 'password' }, 401);
    }
    const fresh = Date.now() - (sess.ts || 0) < PWD_FREE_WINDOW;
    const sameIp = sess.ip && sess.ip === ip;
    if (!fresh && !sameIp) {
      return jx({ ok: false, error: 'Network changed, please re-enter password', need: 'password' }, 401);
    }
    /* 续期节流:原来每次页面加载(前端 800ms 自动 maybeSilentLogin)都写一次 KV,
       一个活跃客户一天轻松烧掉几十次写入。现在距上次落盘不足 5 分钟就只回报成功、
       不写 KV —— 滑动窗口语义保留(5 分钟粒度),写入量降一个数量级。 */
    const lastTs = sess.ts || 0;
    sess.ts = Date.now();
    sess.ip = ip;
    if (sess.ts - lastTs > 5 * 60 * 1000) {
      await storePut(env, 'auth:' + email, JSON.stringify(sess));
    }
    return jx({ ok: true, renewed: true, reason: fresh ? 'within-10min' : 'same-ip-device', ts: sess.ts, ttl: PWD_FREE_WINDOW });
  }

  /* ---------- 找回密码:邮件 code 验证 → 重设 6 位密码 ----------
     走的是"发 code → 校验 code → 直接改成新密码",而不是退回登录态,
     因为用户点"忘记密码"的场景就是密码已经忘了。 */
  if (path === '/api/auth/reset-password' && req.method === 'POST') {
    const pw = String(body.password || '');
    const code = String(body.code || '').trim();
    if (!/^\d{6}$/.test(pw)) return jx({ ok: false, error: 'Password must be exactly 6 digits' }, 400);
    if (!/^\d{6}$/.test(code)) return jx({ ok: false, error: 'Please enter the 6-digit code from your email' }, 400);
    if (!storeOk(env)) return jx({ ok: false, error: 'Session store not configured' }, 503);

    /* 校验 code:必须和刚刚发给这个邮箱的 code 一致 */
    const otpKey = 'otp:email:' + email;
    const real = await storeGet(env, otpKey);
    if (!real) return jx({ ok: false, error: 'Code expired — please request a new one' }, 400);
    if (real !== code) return jx({ ok: false, error: 'Wrong code' }, 400);
    await storeDel(env, otpKey);          /* 一次性,用完即焚 */

    /* 账号必须存在 */
    if (!env.DB) return jx({ ok: false, error: 'DB not configured' }, 503);
    const u = await getUserByEmail(env, email);
    if (!u) return jx({ ok: false, error: 'Email not registered. Please register first.' }, 404);

    await ensurePwdCols(env);
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await pbkdf2(pw, salt);
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, password_salt = ?, pw_set_at = ?, device_id = ? WHERE lower(trim(email)) = ?'
    ).bind(hash, salt, Date.now(), deviceId || (u.device_id || ''), email).run();

    /* 重设密码 = 本机验证通过 → 直接开免密会话,用户不必再输一次 */
    let token = '';
    if (storeOk(env)) {
      token = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      await storePut(env, 'auth:' + email, JSON.stringify({ ip: ip, deviceId: deviceId, token: token, ts: Date.now() }));
    }
    return jx({ ok: true, reset: true, token: token, ts: Date.now(), ttl: PWD_FREE_WINDOW });
  }

  /* ---------- 退出:清掉免密会话 ---------- */
  if (path === '/api/auth/logout' && req.method === 'POST') {
    await storeDel(env, 'auth:' + email);
    return jx({ ok: true, loggedOut: true });
  }

  return jx({ ok: false, error: 'Unknown auth route' }, 404);
}

/* ==================================================================
   WhatsApp 登录链接
   为什么用"一次性链接"而不是"WhatsApp 收 6 位码":
     个人号无法自动发码(我们只有 wa.me 深链,没有 WhatsApp Business API),
     所以走「客户点一下 → 生成一次性链接 → 链接发到邮箱 + 客服在后台把链接
     通过 WhatsApp 发过去 → 客户点链接即登录」这条路。
   链路:
     POST /api/auth/wa-request  申请(邮箱 + WhatsApp 号)→ 生成 token
     GET  /api/auth/wa-verify   校验 token → 建立免密会话 → 返回 email
     GET  /api/auth/wa-requests 后台看待处理请求(客服手动把链接发给客户)
   ================================================================== */
const WA_LOGIN_TTL = 1800;              /* 链接 30 分钟有效 */
const WA_LOGIN_PREFIX = 'walogin:';

/* 登录链接的站点域名。
   wa-request(生成链接)和 wa-requests(后台列表)必须用同一个域名,
   否则客服从后台复制的链接会跟客户申请时拿到的链接对不上 → 客户点了打不开。
   优先级:SITE_URL 变量 > 请求 Origin > 官方主域。 */
function waSiteUrl(env, req) {
  let site = (env.SITE_URL || '').trim();
  if (!site) {
    try {
      const origin = req.headers.get('Origin');
      if (origin && /^https?:\/\//.test(origin)) site = origin;
    } catch (e) { /* req 可能没有 headers */ }
  }
  if (!site) site = 'https://okadafrica.com';
  return site.replace(/\/+$/, '');
}

async function ensureWaTable(env) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS wa_login_requests (' +
      'id TEXT PRIMARY KEY, email TEXT, phone TEXT, token TEXT, status TEXT DEFAULT \'pending\', ' +
      'ip TEXT DEFAULT \'\', created_at INTEGER)'
    ).run();
  } catch (e) { /* 已存在 */ }
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_login_created ON wa_login_requests(created_at DESC)').run(); } catch (e) {}
}

async function handleWaAuth(req, env, path, url) {
  const jw = (d, st) => json(d, st || 200, true);   /* 鉴权响应禁止 CDN 缓存 */
  const ip = clientIp(req);
  let body = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { return jw({ ok: false, error: 'Invalid JSON' }, 400); }
  }

  /* ---------- 申请一次性登录链接 ---------- */
  if (path === '/api/auth/wa-request' && req.method === 'POST') {
    const email = emailKey(body.email);
    const phone = String(body.phone || '').trim();
    const deviceId = String(body.deviceId || '').slice(0, 64);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jw({ ok: false, error: 'Valid email required' }, 400);
    }
    if (phone.replace(/\D/g, '').length < 8) {
      return jw({ ok: false, error: 'Please enter a valid WhatsApp number' }, 400);
    }
    if (!env.DB) return jw({ ok: false, error: 'DB not configured' }, 503);

    const u = await getUserByEmail(env, email);
    if (!u) return jw({ ok: false, error: 'Email not registered. Please register first.' }, 404);

    /* 60 秒节流:同一个邮箱不要反复生成链接(走 store 层,兼容 D1 / KV) */
    if (storeOk(env)) {
      const cd = 'wacd:' + email;
      if (await storeGet(env, cd)) {
        return jw({ ok: false, error: 'Please wait 60s before requesting another link' }, 429);
      }
      await storePut(env, cd, '1', { expirationTtl: 60 });
    }

    const token = bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
    /* token 写入走统一 store 层(优先 D1,回退 KV)——必须与 wa-verify 的读取路径一致,
       否则只有 D1 没 KV 的环境会出现「写了但读不到」的幽灵 token。 */
    if (storeOk(env)) {
      await storePut(env, WA_LOGIN_PREFIX + token, JSON.stringify({ email: email, phone: phone, ts: Date.now() }), { expirationTtl: WA_LOGIN_TTL });
    }

    await ensureWaTable(env);
    const id = 'WAL' + Date.now().toString(36).toUpperCase();
    try {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO wa_login_requests (id, email, phone, token, status, ip, created_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(id, email, phone, token, 'pending', ip, Date.now()).run();
    } catch (e) { /* 记录失败不阻断主流程 */ }

    /* 链接本体:站点域名统一走 waSiteUrl(),与后台列表保持一致 */
    const link = waSiteUrl(env, req) + '/?wa=' + token;

    /* 邮件通道能走就顺手把链接发到邮箱(自助);发不了就靠客服在后台复制链接 WhatsApp 发 */
    let emailed = false;
    if (env.BREVO_API_KEY) {
      const html = '<p>Hi ' + (u.name || 'there') + ',</p>'
        + '<p>Use this link to sign in to OKAD AFRICA. It works once and expires in 30 minutes.</p>'
        + '<p style="font-size:16px;font-weight:700"><a href="' + link + '">Sign in to OKAD AFRICA</a></p>'
        + '<p style="color:#888;font-size:12px">If you did not request this, ignore this email.</p>';
      const r = await sendNotifyEmail(email, 'Your OKAD AFRICA sign-in link', html, env);
      emailed = !!r.ok;
    }

    return jw({ ok: true, id: id, token: token, link: link, emailed: emailed, expiresIn: WA_LOGIN_TTL });
  }

  /* ---------- 校验一次性链接 → 直接登录 ---------- */
  if (path === '/api/auth/wa-verify' && req.method === 'GET') {
    const token = String(url.searchParams.get('token') || '').trim();
    const deviceId = String(url.searchParams.get('deviceId') || '').slice(0, 64);
    if (!token) return jw({ ok: false, error: 'Missing token' }, 400);
    if (!storeOk(env)) return jw({ ok: false, error: 'Session store not configured' }, 503);

    /* 用过即焚 + 留一张"已用过"的标记。
       KV 的删除在全球节点上最多要 60s 才收敛,只 delete 的话同一个链接
       在这 60s 内还能被重放一次 —— used 标记把这条缝补上。 */
    const usedKey = WA_LOGIN_PREFIX + 'used:' + token;
    if (await storeGet(env, usedKey)) {
      return jw({ ok: false, error: 'This sign-in link has already been used' }, 400);
    }
    const raw = await storeGet(env, WA_LOGIN_PREFIX + token);
    if (!raw) return jw({ ok: false, error: 'This sign-in link has expired or was already used' }, 400);
    let rec = {};
    try { rec = JSON.parse(raw); } catch (e) {}
    const email = emailKey(rec.email || '');
    if (!email) return jw({ ok: false, error: 'Invalid sign-in link' }, 400);

    await storeDel(env, WA_LOGIN_PREFIX + token);
    await storePut(env, usedKey, '1', { expirationTtl: 3600 });

    const u = await getUserByEmail(env, email);
    if (!u) return jw({ ok: false, error: 'Email not registered. Please register first.' }, 404);

    /* 建立免密会话 → 客户点链接后 10 分钟内不用再输密码(走 store 层) */
    let sessToken = '';
    if (storeOk(env)) {
      sessToken = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      await storePut(env, 'auth:' + email, JSON.stringify({ ip: ip, deviceId: deviceId, token: sessToken, ts: Date.now() }));
    }

    /* 标记请求已完成 */
    try {
      await env.DB.prepare('UPDATE wa_login_requests SET status = ? WHERE token = ?').bind('used', token).run();
    } catch (e) {}

    /* 返回完整的用户档案字段。
       前端 handleWaLoginToken 会用这些字段在「本地没有该用户档案」时
       先建一条本地档案再恢复登录,避免客户被弹到注册页。
       phone / country / regTs / kycStatus 缺一个都不影响登录成败,
       但缺了会让兜底档案不完整(电话空、国家默认、KYC 状态丢失)。 */
    return jw({
      ok: true, verified: true,
      email: email,
      name: u.name || '',
      phone: u.phone || '',
      country: u.country || '',
      regTs: u.regTs || 0,
      kycStatus: u.kycStatus || 'pending',
      idType: u.idType || '',
      token: sessToken, ts: Date.now(), ttl: PWD_FREE_WINDOW
    });
  }

  /* ---------- 后台:待处理的 WhatsApp 登录请求 ---------- */
  if (path === '/api/auth/wa-requests' && req.method === 'GET') {
    if (!env.DB) return jw({ ok: false, error: 'DB not configured' }, 503);
    await ensureWaTable(env);
    try {
      const r = await env.DB.prepare(
        'SELECT id, email, phone, token, status, created_at FROM wa_login_requests ORDER BY created_at DESC LIMIT 50'
      ).all();
      const site = waSiteUrl(env, req);
      const rows = (r.results || []).map(function (x) {
        return {
          id: x.id, email: x.email, phone: x.phone, status: x.status, createdAt: x.created_at,
          link: site + '/?wa=' + x.token
        };
      });
      return jw({ ok: true, requests: rows });
    } catch (e) {
      return jw({ ok: false, error: String(e.message || e) }, 500);
    }
  }

  return jw({ ok: false, error: 'Unknown WhatsApp auth route' }, 404);
}
