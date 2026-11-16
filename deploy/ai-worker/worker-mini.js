export default {
  async fetch(req, env, ctx) {
    var u = new URL(req.url);
    var p = u.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }});
    }

    if (req.method === "GET" && (p === "/" || p === "")) {
      return j({
        ok: true,
        service: "OKAD API",
        muse: !!env.OPENROUTER_API_KEY,
        email: !!env.RESEND_API_KEY,
        db: !!env.DB,
        ts: Date.now()
      });
    }

    if (p === "/api/exchange-rates") return fx(ctx);

    var m = p.match(/^\/api\/db\/([a-z_]+)$/);
    if (m) return db(req, env, m[1]);

    return j({ ok: false, err: "404" }, 404);
  }
};

function j(d, s) {
  return new Response(JSON.stringify(d), {
    status: s || 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

async function fx(ctx) {
  try {
    var r = await fetch("https://open.er-api.com/v6/latest/USD");
    var d = await r.json();
    return j({ ok: true, base: "USD", rates: d.rates, ts: Date.now() });
  } catch (e) {
    return j({ ok: false, err: e.message }, 502);
  }
}

async function db(req, env, t) {
  if (!env.DB) return j({ ok: false, err: "no DB" }, 503);
  var ok = ["users", "orders", "cooperation", "kyc_logs", "fx_snapshots", "config"];
  if (ok.indexOf(t) < 0) return j({ ok: false, err: "bad table" }, 400);

  try {
    if (req.method === "GET") {
      var u = new URL(req.url);
      var params = {};
      u.searchParams.forEach(function(v, k) {
        var m = String(v).match(/^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.+)$/);
        params[k] = m ? m[2] : v;
      });
      var limit = parseInt(params.limit) || 500;
      delete params.limit;
      var order = params.order || '';
      delete params.order;
      var sql = "SELECT * FROM " + t;
      var keys = Object.keys(params);
      var vals = [];
      if (keys.length) {
        sql += " WHERE " + keys.map(function(k){return k+"=?"}).join(" AND ");
        keys.forEach(function(k){ vals.push(params[k]) });
      }
      sql += " LIMIT " + limit;
      if (order) {
        var om = order.match(/^(\w+)\.(desc|asc)$/i);
        if (om) sql += " ORDER BY " + om[1] + " " + om[2].toUpperCase();
      }
      var r = await env.DB.prepare(sql).bind.apply(null, vals).all();
      return j({ ok: true, rows: r.results || [] });
    }
    if (req.method === "POST") {
      var b = await req.json();
      var k = Object.keys(b);
      var ph = k.map(function () { return "?" }).join(",");
      var sql = "INSERT OR REPLACE INTO " + t + " (" + k.join(",") + ") VALUES (" + ph + ")";
      await env.DB.prepare(sql).bind.apply(null, k.map(function (x) { return b[x] })).run();
      return j({ ok: true, saved: true });
    }
    if (req.method === "PATCH") {
      var b = await req.json();
      var u = new URL(req.url);
      var wp = {};
      u.searchParams.forEach(function(v, k) {
        var m = String(v).match(/^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.+)$/);
        wp[k] = m ? m[2] : v;
      });
      var wk = Object.keys(wp);
      if (!wk.length) return j({ ok: false, err: "PATCH needs WHERE" }, 400);
      var sk = Object.keys(b);
      if (!sk.length) return j({ ok: false, err: "PATCH needs body" }, 400);
      var sql = "UPDATE " + t + " SET " + sk.map(function(k){return k+"=?"}).join(", ") + " WHERE " + wk.map(function(k){return k+"=?"}).join(" AND ");
      var vals = sk.map(function(k){return b[k]}).concat(wk.map(function(k){return wp[k]}));
      await env.DB.prepare(sql).bind.apply(null, vals).run();
      return j({ ok: true, updated: true });
    }
    if (req.method === "DELETE") {
      var u = new URL(req.url);
      var wp = {};
      u.searchParams.forEach(function(v, k) {
        var m = String(v).match(/^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.+)$/);
        wp[k] = m ? m[2] : v;
      });
      var wk = Object.keys(wp);
      if (!wk.length) return j({ ok: false, err: "DELETE needs WHERE" }, 400);
      var sql = "DELETE FROM " + t + " WHERE " + wk.map(function(k){return k+"=?"}).join(" AND ");
      await env.DB.prepare(sql).bind.apply(null, wk.map(function(k){return wp[k]})).run();
      return j({ ok: true, deleted: true });
    }
    return j({ ok: false, err: "405" }, 405);
  } catch (e) {
    return j({ ok: false, err: e.message }, 500);
  }
}
