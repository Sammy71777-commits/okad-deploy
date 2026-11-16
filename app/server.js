/**
 * OKAD AFRICA — 应用服务器
 * 1. 托管 site/ 静态文件
 * 2. 提供 /api/search 代理（服务端持有 Exa key，规避浏览器 CORS 限制）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'site');
const EXA_KEY = process.env.EXA_API_KEY || 'bd3e0d67-d954-4f7a-bbb9-ef185a05e2d0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function proxyExa(payload, res) {
  const body = JSON.stringify(Object.assign(
    { contents: { text: { maxCharacters: 800 } } },
    payload
  ));
  const req = https.request({
    hostname: 'api.exa.ai',
    path: '/search',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': EXA_KEY,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 25000,
  }, (r) => {
    let data = '';
    r.on('data', (c) => { data += c; });
    r.on('end', () => {
      res.writeHead(r.statusCode === 200 ? 200 : 502, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  });
  req.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'exa_unreachable', message: e.message }));
  });
  req.on('timeout', () => {
    req.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'exa_timeout' }));
  });
  req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ---- API 代理 ----
  if (parsed.pathname === '/api/search') {
    if (req.method !== 'POST') {
      res.writeHead(405); return res.end('Method Not Allowed');
    }
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'bad_json' }));
      }
      proxyExa(payload, res);
    });
    return;
  }

  // ---- 静态文件 ----
  let p = decodeURIComponent(parsed.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const filePath = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA 回退
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OKAD AFRICA listening on 0.0.0.0:${PORT}`);
});