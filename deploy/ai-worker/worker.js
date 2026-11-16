/**
 * OKAD Worker - Lite Version (10KB)
 * Core routes: /api/muse, /api/email-code, /api/exchange-rates, /api/db/*, /api/search, /api/shipping-rates
 */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (req.method === 'GET' && path === '/') {
      return json({
        ok: true,
        service: 'OKAD Worker Lite',
        routes: ['/api/muse', '/api/email-code', '/api/exchange-rates', '/api/db/{table}', '/api/search', '/api/shipping-rates'],
        muse_configured: !!env.OPENROUTER_API_KEY,
        email_configured: !!env.RESEND_API_KEY,
        db_configured: !!env.DB,
        exa_configured: !!env.EXA_API_KEY,
        ts: Date.now()
      });
    }

    if (path === '/api/muse' && req.method === 'POST') {
      return handleMuse(req, env);
    }

    if (path === '/api/email-code' && req.method === 'POST') {
      return handleEmailCode(req, env);
    }

    if (path === '/api/exchange-rates' && req.method === 'GET') {
      return handleFx(req, env, ctx);
    }

    if (path === '/api/orders/recent' && req.method === 'GET') {
      return handleRecentOrders(req, env);
    }

    if (path === '/api/config' && req.method === 'GET') {
      return handleConfig(req, env);
    }

    if (path === '/api/search' && req.method === 'POST') {
      return handleExaSearch(req, env);
    }

    if (path === '/api/shipping-rates' && req.method === 'GET') {
      return handleShippingRates(req, env);
    }

    const dbMatch = path.match(/^\/api\/db\/([a-z_]+)$/);
    if (dbMatch) {
      return handleDb(req, env, dbMatch[1]);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

/* ========== /api/muse ========== */
async function handleMuse(req, env) {
  if (!env.OPENROUTER_API_KEY) {
    return json({ ok: false, error: 'OPENROUTER_API_KEY not configured' }, 503);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
  const prompt = (body.prompt || '').trim();
  if (prompt.length < 4) return json({ ok: false, error: 'Prompt too short' }, 400);

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://okad.africa',
        'X-Title': 'OKAD Africa'
      },
      body: JSON.stringify({
        model: 'bytedance/seedream-3-pt',
        prompt: prompt,
        n: 1,
        size: '1024x1024'
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return json({ ok: false, error: 'OpenRouter error: ' + text.slice(0, 200) }, 502);
    }

    const data = await resp.json();
    const img = data.data?.[0];
    if (!img) return json({ ok: false, error: 'No image returned' }, 502);

    return json({
      ok: true,
      image: img.url || ('data:image/png;base64,' + img.b64_json),
      model: 'bytedance/seedream-3-pt'
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}

/* ========== /api/email-code ========== */
async function handleEmailCode(req, env) {
  if (!env.RESEND_API_KEY) {
    return json({ ok: false, error: 'RESEND_API_KEY not configured', demo: true });
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
  const email = (body.email || '').trim().toLowerCase();
  if (!email.includes('@')) return json({ ok: false, error: 'Invalid email' }, 400);

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'OKAD Africa <noreply@okad.africa>',
        to: email,
        subject: 'Your OKAD verification code',
        html: '<p>Your code: <b>' + code + '</b></p><p>Valid for 10 minutes.</p>'
      })
    });
    return json({ ok: true, sent: true, code: code });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

/* ========== /api/orders/recent ========== */
async function handleRecentOrders(req, env) {
  if (!env.DB) return json({ ok: false, error: 'DB not configured' }, 503);

  try {
    /* orders 表: id, user_email, data(json), status, amount, created_at
       趋势页需要 product/qty/total/route/method — 都存在 data JSON 里 */
    const { results } = await env.DB.prepare(
      'SELECT id, data, status, created_at FROM orders ORDER BY created_at DESC LIMIT 30'
    ).all();

    // 如果表为空，返回模拟数据（演示用）
    if (!results || results.length === 0) {
      return json({
        ok: true,
        orders: [
          { id: 'ORD-1', product: 'Phone Accessories', qty: 500, total: 425, status: 'Shipping', route: 'Shenzhen → Tema', method: 'sea', createdTs: Date.now() - 300000, emoji: '📱' },
          { id: 'ORD-2', product: 'Solar Panels', qty: 50, total: 2100, status: 'Confirmed', route: 'Shenzhen → Tema', method: 'sea', createdTs: Date.now() - 900000, emoji: '☀️' },
          { id: 'ORD-3', product: 'Auto Parts', qty: 200, total: 2400, status: 'Purchasing', route: 'Guangzhou → Tema', method: 'sea', createdTs: Date.now() - 1800000, emoji: '🚗' },
          { id: 'ORD-4', product: 'Fitness Equipment', qty: 50, total: 2250, status: 'Shipping', route: 'Shenzhen → Tema', method: 'sea', createdTs: Date.now() - 3600000, emoji: '🏋️' },
          { id: 'ORD-5', product: 'TWS Earbuds', qty: 300, total: 960, status: 'Confirmed', route: 'Yiwu → Accra', method: 'sea', createdTs: Date.now() - 7200000, emoji: '🎧' },
          { id: 'ORD-6', product: 'Solar Street Light', qty: 80, total: 2800, status: 'Shipping', route: 'Shenzhen → Tema', method: 'sea', createdTs: Date.now() - 10800000, emoji: '💡' }
        ],
        demo: true
      });
    }

    const emojiMap = {
      'Phone Accessories': '📱', 'Solar Panels': '☀️', 'Auto Parts': '🚗',
      'Fitness Equipment': '🏋️', 'TWS Earbuds': '🎧', 'Solar Street Light': '💡',
      'USB-C Cables': '📱', 'Brake Pads': '🚗', 'Dumbbell Set': '🏋️'
    };

    const orders = results.map(row => {
      /* 从 data JSON 提取字段 */
      let d = {};
      if (row.data) {
        try { d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch (e) { d = {}; }
      }
      const product = d.product || d.cargoDesc || d.pname || 'Product';
      return {
        id: row.id,
        product: product,
        qty: d.qty || d.pcs || d.quantity || 0,
        total: d.totalUSD || d.total || d.amount || row.amount || 0,
        status: row.status || d.status || 'Pending',
        route: d.route || 'China → Ghana',
        method: d.method || 'sea',
        createdTs: d.createdAt || row.created_at || Date.now(),
        emoji: emojiMap[product] || '📦'
      };
    });

    return json({ ok: true, orders });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ========== /api/config ========== */
async function handleConfig(req, env) {
  /* 优先从数据库读取，没有则返回默认配置 */
  let config = null;
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT data FROM config WHERE key = ?').bind('site').first();
      if (row && row.data) config = JSON.parse(row.data);
    } catch (e) { /* 表可能不存在 */ }
  }

  /* 默认值 — 管理员可在 D1 修改 */
  const defaults = {
    whatsapp: {
      number: '233505615533',
      label: 'Chat on WhatsApp',
      text: 'Hello OKAD AFRICA, I want a shipping quote from China to Africa.'
    },
    referral: {
      code: 'OKAD-NEW10',
      reward: '$10',
      title: 'Share OKAD & Earn $10',
      desc: 'Invite friends — they get $10 off first order, you earn $10 credit'
    },
    contact: {
      email: 'support@okad.africa',
      hours: 'Mon-Fri 9:00-18:00 GMT'
    }
  };

  return json({ ok: true, config: config || defaults });
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
async function handleDb(req, env, table) {
  if (!env.DB) return json({ ok: false, error: 'DB not configured' }, 503);

  const validTables = ['users', 'orders', 'cooperation', 'kyc_logs', 'fx_snapshots', 'config'];
  if (!validTables.includes(table)) {
    return json({ ok: false, error: 'Invalid table' }, 400);
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const params = {};
      for (const [k, v] of url.searchParams) {
        /* 支持 eq.xxx 语法，剥掉操作符 */
        const m = String(v).match(/^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.+)$/);
        params[k] = m ? m[2] : v;
      }
      const limit = parseInt(params.limit) || 500;
      delete params.limit;
      const order = params.order || '';
      delete params.order;

      let sql = 'SELECT * FROM ' + table;
      const keys = Object.keys(params);
      const vals = [];
      if (keys.length) {
        sql += ' WHERE ' + keys.map(k => k + ' = ?').join(' AND ');
        for (const k of keys) vals.push(params[k]);
      }
      sql += ' LIMIT ' + limit;
      if (order) {
        const om = order.match(/^(\w+)\.(desc|asc)$/i);
        if (om) sql += ' ORDER BY ' + om[1] + ' ' + om[2].toUpperCase();
      }
      const { results } = await env.DB.prepare(sql).bind(...vals).all();
      return json({ ok: true, rows: results });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const keys = Object.keys(body);
      const placeholders = keys.map(() => '?').join(',');
      const sql = 'INSERT OR REPLACE INTO ' + table + ' (' + keys.join(',') + ') VALUES (' + placeholders + ')';
      await env.DB.prepare(sql).bind(...keys.map(k => body[k])).run();
      return json({ ok: true, inserted: true });
    }

    if (req.method === 'PATCH') {
      const body = await req.json();
      const url = new URL(req.url);
      const whereParams = {};
      for (const [k, v] of url.searchParams) {
        const m = String(v).match(/^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.+)$/);
        whereParams[k] = m ? m[2] : v;
      }
      const whereKeys = Object.keys(whereParams);
      if (!whereKeys.length) return json({ ok: false, error: 'PATCH requires WHERE clause' }, 400);

      const setKeys = Object.keys(body);
      if (!setKeys.length) return json({ ok: false, error: 'PATCH requires fields in body' }, 400);

      /* orders 表的 data 字段是 JSON — 支持 deep merge */
      if (table === 'orders' && body.data && typeof body.data === 'object') {
        /* 先读现有行，合并 data，再写回 */
        const whereClause = whereKeys.map(k => k + ' = ?').join(' AND ');
        const whereVals = whereKeys.map(k => whereParams[k]);
        const existing = await env.DB.prepare('SELECT data FROM ' + table + ' WHERE ' + whereClause + ' LIMIT 1').bind(...whereVals).first();
        if (existing && existing.data) {
          try {
            const oldData = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
            const newData = JSON.parse(JSON.stringify(body.data));
            body.data = JSON.stringify(Object.assign({}, oldData, newData));
          } catch (e) { /* 合并失败就原样写入 */ }
        }
      }

      const sql = 'UPDATE ' + table + ' SET ' + setKeys.map(k => k + ' = ?').join(', ') + ' WHERE ' + whereKeys.map(k => k + ' = ?').join(' AND ');
      const vals = setKeys.map(k => body[k]).concat(whereKeys.map(k => whereParams[k]));
      await env.DB.prepare(sql).bind(...vals).run();
      return json({ ok: true, updated: true });
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      const whereParams = {};
      for (const [k, v] of url.searchParams) {
        const m = String(v).match(/^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.+)$/);
        whereParams[k] = m ? m[2] : v;
      }
      const whereKeys = Object.keys(whereParams);
      if (!whereKeys.length) return json({ ok: false, error: 'DELETE requires WHERE clause' }, 400);

      const sql = 'DELETE FROM ' + table + ' WHERE ' + whereKeys.map(k => k + ' = ?').join(' AND ');
      await env.DB.prepare(sql).bind(...whereKeys.map(k => whereParams[k])).run();
      return json({ ok: true, deleted: true });
    }

    return json({ ok: false, error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ========== Exa AI Search (find real suppliers & products) ========== */
async function handleExaSearch(req, env) {
  var apiKey = env.EXA_API_KEY || 'bd3e0d67-d954-4f7a-bbb9-ef185a05e2d0';
  if (!apiKey) {
    return json({ ok: false, error: 'EXA_API_KEY not configured', fallback: true }, 503);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
  const query = (body.query || '').trim();
  if (!query) return json({ ok: false, error: 'Query required' }, 400);

  /* 构建搜索提示：针对B2B采购场景 */
  const searchPrompt = query + ' wholesale supplier manufacturer China Alibaba 1688 price MOQ';

  try {
    const resp = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify({
        query: searchPrompt,
        numResults: 8,
        type: 'keyword',  /* 先用keyword模式，更直接匹配产品页 */
        includeDomains: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'alibaba.com', '1688.com', 'made-in-china.com', 'globalsources.com'],
        contents: {
          text: { maxCharacters: 800 }
        }
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return json({ ok: false, error: 'Exa error: ' + text.slice(0, 200), fallback: true }, 502);
    }

    const data = await resp.json();
    const results = (data.results || []).map(r => ({
      title: r.title || 'Product',
      url: r.url || '',
      snippet: r.text || '',
      score: r.score || 0,
      imageUrl: r.imageUrl || r.image || r.thumbnail || '',
      supplier: r.supplier || '',
      rating: r.rating || null,
      moq: r.moq || null,
      publishedDate: r.publishedDate || ''
    }));

    return json({
      ok: true,
      query: query,
      results: results,
      source: 'exa'
    });
  } catch (e) {
    return json({ ok: false, error: e.message, fallback: true }, 502);
  }
}

/* ========== Shipping Rates (real-time search) ========== */
async function handleShippingRates(req, env) {
  var apiKey = env.EXA_API_KEY || 'bd3e0d67-d954-4f7a-bbb9-ef185a05e2d0';
  if (!apiKey) {
    return json({ ok: false, error: 'EXA_API_KEY not configured', fallback: true }, 503);
  }

  const url = new URL(req.url);
  const route = (url.searchParams.get('route') || 'China to Africa sea freight rate 2026').trim();

  try {
    const resp = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify({
        query: route + ' container shipping freight rate price USD CBM kg 2026',
        numResults: 6,
        type: 'keyword',
        contents: {
          text: { maxCharacters: 600 }
        }
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return json({ ok: false, error: 'Exa error: ' + text.slice(0, 200), fallback: true }, 502);
    }

    const data = await resp.json();
    const results = (data.results || []).map(r => ({
      title: r.title || 'Shipping Rate',
      url: r.url || '',
      snippet: r.text || '',
      score: r.score || 0
    }));

    return json({
      ok: true,
      route: route,
      results: results,
      source: 'exa',
      disclaimer: 'Rates are for reference only. Contact OKAD for confirmed quotes.'
    });
  } catch (e) {
    return json({ ok: false, error: e.message, fallback: true }, 502);
  }
}
