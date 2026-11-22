// Segment Hub API server. Zero dependencies: Node's built-in http only.
// Serves the same engine the browser demo uses, plus the demo page.
const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('./src/engine.js');

const PORT = process.env.PORT || 3000;
const hub = E.createHub({ seed: true });

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['src/engine.js', 'application/javascript; charset=utf-8'],
  '/suite.js': ['test/suite.js', 'application/javascript; charset=utf-8'],
  '/about.js': ['public/about.js', 'application/javascript; charset=utf-8'],
  '/about.md': ['public/about.md', 'text/markdown; charset=utf-8'],
  '/assets/sid-avatar.svg': ['public/assets/sid-avatar.svg', 'image/svg+xml']
};

// Very small per-IP rate limit so a public prototype cannot be hammered.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10000, max = 200;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, if-none-match',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-expose-headers': 'etag, location, idempotent-replay'
  }, headers));
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (req.method === 'OPTIONS') return send(res, 204, {}, '');
  if (url.pathname === '/favicon.ico') return send(res, 204, {}, '');
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return fs.readFile(path.join(__dirname, file), (err, data) => err ? send(res, 404, { 'content-type': 'text/plain' }, 'not found') : send(res, 200, { 'content-type': type, 'cache-control': 'no-cache' }, data));
  }
  if (limited(ip)) return send(res, 429, { 'content-type': 'application/json' }, JSON.stringify({ error: 'rate_limited', message: 'Too many requests. Slow down' }));
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => { size += c.length; if (size > 200000) { tooBig = true; req.destroy(); } else chunks.push(c); });
  req.on('close', () => {});
  req.on('end', () => {
    if (tooBig) return send(res, 413, { 'content-type': 'application/json' }, JSON.stringify({ error: 'payload_too_large', message: 'Body over 200 KB' }));
    let body;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) { try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { 'content-type': 'application/json' }, JSON.stringify({ error: 'invalid_json', message: 'Body is not valid JSON' })); } }
    const query = {}; url.searchParams.forEach((v, k) => { query[k] = v; });
    const out = hub.handle({ method: req.method, path: url.pathname, query, headers: req.headers, body });
    const headers = Object.assign({ 'content-type': 'application/json' }, out.headers || {});
    if (out.status === 304) return send(res, 304, headers, '');
    send(res, out.status, headers, JSON.stringify(out.body, null, 2));
  });
});

server.listen(PORT, () => console.log('Segment Hub listening on http://localhost:' + PORT));
