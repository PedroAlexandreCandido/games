import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Auth, AuthError } from './auth.js';
import { Lobby } from './lobby.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// `/shared/*` serves the game logic that both the browser and the server import.
const MOUNTS = [
  ['/shared/', join(ROOT, 'shared')],
  ['/', join(ROOT, 'public')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const TICK_MS = 1000 / 60;
const HEARTBEAT_MS = 15000;
const MAX_BODY = 2048;

async function serveStatic(req, res) {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const [prefix, dir] = MOUNTS.find(([p]) => pathname.startsWith(p));
    const file = resolve(dir, '.' + pathname.slice(prefix.length - 1));
    if (!file.startsWith(dir + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// HTTP server for the client files, the admin login API and the game
// WebSocket at /ws. Matches are stepped on a fixed 60 Hz loop and state is
// pushed to players every step.
//   admins: Map of username → password hash (empty: no login needed)
//   sessionSecret: signs session cookies; set it so logins survive restarts
//   trustProxy: read the client IP and HTTPS from X-Forwarded-* headers
export function createApp({ admins = new Map(), sessionSecret = null, trustProxy = false } = {}) {
  const auth = new Auth({ admins, secret: sessionSecret });
  const lobby = new Lobby({ loginRequired: auth.enabled });

  const clientIp = (req) =>
    (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress;
  const isHttps = (req) => Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/me' && req.method === 'GET') {
      sendJson(res, 200, { user: auth.userFromCookieHeader(req.headers.cookie), loginRequired: auth.enabled });
    } else if (pathname === '/api/login' && req.method === 'POST') {
      // Requiring a JSON content type keeps plain cross-site form posts out.
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        sendJson(res, 415, { error: 'Expected JSON.' });
        return;
      }
      try {
        const { username, password } = await readJson(req);
        const token = auth.login(username, password, clientIp(req));
        sendJson(res, 200, { user: String(username) }, { 'set-cookie': auth.sessionCookie(token, isHttps(req)) });
      } catch (err) {
        sendJson(res, err instanceof AuthError ? 401 : 400, { error: err instanceof AuthError ? err.message : 'Bad request.' });
      }
    } else if (pathname === '/api/logout' && req.method === 'POST') {
      sendJson(res, 200, { user: null }, { 'set-cookie': auth.clearedCookie(isHttps(req)) });
    } else {
      sendJson(res, 404, { error: 'Not found.' });
    }
  }

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) handleApi(req, res, pathname);
    else serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (ws, req) => {
    // Browsers always send Origin. Refusing other sites' pages stops them from
    // riding on an admin's session cookie.
    const { origin } = req.headers;
    if (origin && URL.parse(origin)?.host !== req.headers.host) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
    ws.alive = true;
    const client = {
      user: auth.userFromCookieHeader(req.headers.cookie),
      send(message) {
        if (ws.readyState === ws.OPEN) ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      },
    };
    lobby.connect(client);
    ws.on('pong', () => (ws.alive = true));
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') lobby.message(client, msg);
    });
    ws.on('close', () => lobby.disconnect(client));
  });

  // Drop connections that stop answering pings, so their seats free up.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  let last = performance.now();
  const loop = setInterval(() => {
    const now = performance.now();
    lobby.tick(Math.min(0.1, (now - last) / 1000));
    last = now;
  }, TICK_MS);

  server.on('close', () => {
    clearInterval(loop);
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
  });

  return { server, lobby, auth };
}
