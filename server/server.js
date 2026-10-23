// HTTP + WebSocket server: serves the phone app, authenticates phones by
// their pairing token, and connects each one to an input Session.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Session } from './engine.js';
import { profileFor, publicProfile } from './layouts.js';
import { tokensEqual } from './config.js';
import { renderPairPage } from './pairpage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = path.resolve(HERE, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createRackpadServer({ backend, token, macName, version, pairing, log = () => {} }) {
  const clients = new Map(); // ws → { session, name }
  let lastContextKey = null;

  const context = () => {
    const app = backend.app ?? {};
    const profile = publicProfile(profileFor(app));
    return { app: { name: app.name, bundleId: app.bundleId, icon: app.icon }, profile };
  };

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  backend.on('app', () => {
    const ctx = context();
    const key = `${ctx.app.bundleId}|${ctx.profile.id}`;
    if (key === lastContextKey) return;
    lastContextKey = key;
    broadcast({ t: 'context', ...ctx });
  });
  backend.on('status', (status) => broadcast({ t: 'status', backend: status }));

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      log(`HTTP error: ${err.stack ?? err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;

    if (p === '/manifest.webmanifest') return sendManifest(res, url.searchParams.get('k'));

    // The pairing page shows the token, so only the Mac itself may open it.
    // The Host check stops DNS-rebinding pages in the Mac's browser too.
    if (p === '/pair' || p.startsWith('/api/')) {
      if (!isLocalRequest(req)) return send(res, 403, 'text/plain', 'The pairing page is only available on the Mac itself.');
      if (p === '/pair') {
        const qr = await QRCode.toString(pairing.primary, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
        return send(res, 200, MIME['.html'], renderPairPage({ qr, pairing, macName, version, dryRun: backend.status.kind === 'dry-run' }));
      }
      if (p === '/api/status') {
        return sendJson(res, {
          backend: backend.status,
          phones: [...clients.values()].map((c) => c.name),
          app: { name: backend.app?.name, bundleId: backend.app?.bundleId },
          profile: profileFor(backend.app).id,
        });
      }
      if (p === '/api/simulate-app' && req.method === 'POST' && backend.status.kind === 'dry-run') {
        const body = JSON.parse((await readBody(req)) || '{}');
        backend.setApp({ bundleId: String(body.bundleId ?? ''), name: String(body.name ?? ''), title: String(body.title ?? '') });
        return sendJson(res, { ok: true });
      }
      return send(res, 404, 'text/plain', 'Not found');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return serveStatic(res, p === '/' ? '/index.html' : p);
  }

  function sendManifest(res, k) {
    const authed = typeof k === 'string' && tokensEqual(k, token);
    const manifest = {
      name: 'Rackpad',
      short_name: 'Rackpad',
      description: `Trackpad, keyboard and remote for ${macName}`,
      start_url: authed ? `/?k=${encodeURIComponent(k)}` : '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#05060f',
      theme_color: '#05060f',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
    send(res, 200, 'application/manifest+json', JSON.stringify(manifest));
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const k = url.searchParams.get('k') ?? '';
      if (!tokensEqual(k, token)) {
        ws.close(4401, 'Unknown pairing code');
        return;
      }
      onClient(ws, req);
    });
  });

  function onClient(ws, req) {
    const name = String(new URL(req.url, 'http://local').searchParams.get('name') ?? 'Phone').slice(0, 40);
    const session = new Session({
      backend,
      onVolume: (v) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'volume', ...v })),
    });
    clients.set(ws, { session, name });
    log(`📱 ${name} connected (${req.socket.remoteAddress})`);

    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.send(JSON.stringify({ t: 'welcome', version, mac: { name: macName }, backend: backend.status, ...context() }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', id: msg.id }));
        return;
      }
      try {
        session.handle(msg);
      } catch (err) {
        log(`Bad message ${JSON.stringify(msg).slice(0, 200)}: ${err.message}`);
      }
    });
    ws.on('close', () => {
      session.dispose();
      clients.delete(ws);
      log(`📱 ${name} disconnected`);
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of clients.keys()) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);
  heartbeat.unref();

  return {
    server,
    clients,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return loopback && LOCAL_HOSTS.has(host);
}

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'text/plain', 'Bad path');
  }
  const file = path.resolve(WEB_DIR, `.${path.posix.normalize(rel)}`);
  if (!file.startsWith(WEB_DIR + path.sep)) return send(res, 404, 'text/plain', 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function sendJson(res, obj) {
  send(res, 200, 'application/json', JSON.stringify(obj));
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
