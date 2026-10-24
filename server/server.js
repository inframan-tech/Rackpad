// HTTP + WebSocket server: serves the phone app, authenticates phones by
// their pairing token, and connects each one to an input Session. With a
// certificate (see tls.js) the same app is served over HTTPS too.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Session } from './engine.js';
import { profileFor, publicProfile } from './layouts.js';
import { tokensEqual } from './config.js';
import { renderPairPage } from './pairpage.js';
import { awdlActive } from './net.js';

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
const MAX_STREAM_WIDTH = 1600; // px across: sharp on a phone, light on Wi-Fi
const STREAM_FPS = 30;
const STREAM_QUALITY = 0.6;

// Third-party browser code, served straight from node_modules.
const VENDOR = new Map([['/vendor/jsQR.js', createRequire(import.meta.url).resolve('jsqr')]]);

export function createRackpadServer({ backend, token, macName, version, pairing, tls = null, log = () => {} }) {
  const clients = new Map(); // ws → { session, name }
  let lastContextKey = null;
  let securePort = null;

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

  // ── Screen streaming ──────────────────────────────────────────────────
  // A phone watching the screen gets the newest frame as soon as it has shown
  // the last one: there's never a queue, so the picture is never behind.
  let streaming = null; // what the helper streams at: { maxWidth }
  let lastFrame = null;
  let darkened = false;
  const watching = () => [...clients.entries()].filter(([, c]) => c.screen.on);

  function updateStream() {
    const viewers = watching();
    if (!viewers.length) {
      if (streaming) backend.send({ op: 'screen', on: false });
      streaming = null;
      lastFrame = null;
      return;
    }
    const maxWidth = Math.min(MAX_STREAM_WIDTH, Math.max(...viewers.map(([, c]) => c.screen.maxWidth)));
    if (streaming?.maxWidth === maxWidth) return;
    if (streaming) backend.send({ op: 'screen', on: false }); // start again at the new size
    backend.send({ op: 'screen', on: true, maxWidth, fps: STREAM_FPS, quality: STREAM_QUALITY });
    streaming = { maxWidth };
  }

  function deliver(ws, c, jpeg) {
    const s = c.screen;
    const showing = s.waiting && performance.now() - s.sentAt < 2000; // no answer in 2 s: send anyway
    if (showing || ws.readyState !== ws.OPEN || ws.bufferedAmount > 2_000_000) {
      s.pending = jpeg;
      return;
    }
    s.pending = null;
    s.waiting = true;
    s.sentAt = performance.now();
    ws.send(jpeg, { binary: true });
  }

  backend.on('frame', (jpeg) => {
    lastFrame = jpeg;
    for (const [ws, c] of watching()) deliver(ws, c, jpeg);
  });
  backend.on('screen', (state) => {
    const data = JSON.stringify({ t: 'screen', ...state });
    for (const [ws] of watching()) if (ws.readyState === ws.OPEN) ws.send(data);
  });

  // Screen off (dark but still drawing) while a watching phone wants it. The
  // helper gives the screen back by itself unless this is renewed.
  function updateScreenOff() {
    const want = watching().some(([, c]) => c.screenOff);
    if (want) backend.send({ op: 'screenOff', on: true });
    else if (darkened) backend.send({ op: 'screenOff', on: false });
    darkened = want;
  }
  const renewScreenOff = setInterval(() => darkened && backend.send({ op: 'screenOff', on: true }), 5000);
  renewScreenOff.unref();
  backend.on('screenOff', (on) => broadcast({ t: 'screenOff', on }));

  const onRequest = (req, res) => {
    handleHttp(req, res).catch((err) => {
      log(`HTTP error: ${err.stack ?? err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  const server = http.createServer(onRequest);
  const secureServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, onRequest) : null;

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;

    if (p === '/manifest.webmanifest') return sendManifest(res, url.searchParams.get('k'));

    // The certificate authority, for the phone to install once (it's public:
    // anyone may see it, and it can only vouch for local names).
    if (p === '/rackpad.crt' && tls) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="Rackpad.crt"',
        'Cache-Control': 'no-store',
      });
      return res.end(tls.caDer);
    }
    // Answered over HTTPS only once the phone trusts the certificate, so the
    // plain page can ask whether the secure one is ready.
    if (p === '/secure-check') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, secure: !!req.socket.encrypted }));
    }

    // The pairing page shows the token, so only the Mac itself may open it.
    // The Host check stops DNS-rebinding pages in the Mac's browser too.
    if (p === '/pair' || p.startsWith('/api/')) {
      if (!isLocalRequest(req)) return send(res, 403, 'text/plain', 'The pairing page is only available on the Mac itself.');
      if (p === '/pair') {
        const qr = await QRCode.toString(pairing.primary, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
        const secureQr = pairing.secure && securePort ? await QRCode.toString(pairing.secure, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }) : null;
        return send(res, 200, MIME['.html'], renderPairPage({ qr, secureQr, pairing, macName, version, dryRun: backend.status.kind === 'dry-run' }));
      }
      if (p === '/api/status') {
        return sendJson(res, {
          backend: backend.status,
          phones: [...clients.values()].map((c) => c.name),
          app: { name: backend.app?.name, bundleId: backend.app?.bundleId },
          profile: profileFor(backend.app).id,
          awdl: backend.status.kind === 'native' && awdlActive(),
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
    if (p === '/' || p === '/index.html') return serveIndex(res, url.searchParams.get('k'));
    if (VENDOR.has(p)) return sendFile(res, VENDOR.get(p));
    return serveStatic(res, p);
  }

  // The page links the manifest with the phone's token already in it: iOS
  // reads the manifest as the page loads, and its start_url is where the Home
  // Screen icon opens, in storage of its own that can't see Safari's.
  function serveIndex(res, k) {
    fs.readFile(path.join(WEB_DIR, 'index.html'), 'utf8', (err, html) => {
      if (err) return send(res, 500, 'text/plain', 'index.html is missing');
      const authed = typeof k === 'string' && tokensEqual(k, token);
      send(res, 200, MIME['.html'], authed ? html.replace('href="/manifest.webmanifest"', `href="/manifest.webmanifest?k=${encodeURIComponent(k)}"`) : html);
    });
  }

  function sendManifest(res, k) {
    const authed = typeof k === 'string' && tokensEqual(k, token);
    const manifest = {
      name: 'Rackpad',
      short_name: 'Rackpad',
      description: `Trackpad, keyboard and remote for ${macName}`,
      // Without a token, start_url defaults to the address of the page that
      // linked the manifest, which carries the token if the page had one.
      ...(authed ? { start_url: `/?k=${encodeURIComponent(k)}` } : {}),
      scope: '/',
      display: 'standalone',
      display_override: ['fullscreen', 'standalone'],
      orientation: 'any', // sideways, the whole phone is the trackpad
      background_color: '#000000',
      theme_color: '#000000',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
    send(res, 200, 'application/manifest+json', JSON.stringify(manifest));
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const onUpgrade = (req, socket, head) => {
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
  };
  server.on('upgrade', onUpgrade);
  secureServer?.on('upgrade', onUpgrade);

  function onClient(ws, req) {
    const name = String(new URL(req.url, 'http://local').searchParams.get('name') ?? 'Phone').slice(0, 40);
    const session = new Session({
      backend,
      onVolume: (v) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'volume', ...v })),
      onStats: backend.verbose ? (st) => log(`glide: ${st.moves} moves in 3s, ${st.late} late, playing ${st.buffer} ms behind`) : null,
    });
    const client = { session, name, screen: { on: false, maxWidth: 1280, waiting: false, pending: null, sentAt: 0 }, screenOff: false };
    clients.set(ws, client);
    log(`📱 ${name} connected (${req.socket.remoteAddress}${platformOf(req.headers['user-agent'])})`);

    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const secure = securePort ? { port: securePort, ca: tls.caName } : null;
    ws.send(JSON.stringify({ t: 'welcome', version, mac: { name: macName }, backend: backend.status, secure, ...context() }));

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
      if (msg?.t === 'screen') {
        client.screen.on = msg.on === true;
        client.screen.maxWidth = Math.round(Math.min(MAX_STREAM_WIDTH, Math.max(320, Number(msg.maxWidth) || 1280)));
        client.screen.waiting = false;
        client.screen.pending = null;
        updateStream();
        updateScreenOff();
        if (client.screen.on && lastFrame) deliver(ws, client, lastFrame);
        return;
      }
      if (msg?.t === 'frameAck') {
        client.screen.waiting = false;
        if (client.screen.on && client.screen.pending) deliver(ws, client, client.screen.pending);
        return;
      }
      if (msg?.t === 'screenOff') {
        client.screenOff = msg.on === true;
        updateScreenOff();
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
      updateStream();
      updateScreenOff();
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

  const listenOn = (srv, port, host) =>
    new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, host, () => {
        srv.off('error', reject);
        resolve(srv.address().port);
      });
    });

  return {
    server,
    secureServer,
    clients,
    listen(port, host = '0.0.0.0') {
      return listenOn(server, port, host);
    },
    async listenSecure(port, host = '0.0.0.0') {
      securePort = await listenOn(secureServer, port, host);
      return securePort;
    },
    // A renewed certificate (the Mac's addresses changed) takes effect for new connections.
    setTls(next) {
      secureServer?.setSecureContext({ key: next.key, cert: next.cert });
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(renewScreenOff);
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
      const closing = [server, secureServer].filter((srv) => srv?.listening).map((srv) => new Promise((resolve) => srv.close(() => resolve())));
      return Promise.all(closing);
    },
  };
}

// "iOS 18.2" or "Android 15" from a browser's User-Agent, for the log.
export function platformOf(ua = '') {
  const ios = /OS (\d+)[_.](\d+)[_\d]* like Mac OS X/.exec(ua);
  if (ios) return `, iOS ${ios[1]}.${ios[2]}`;
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  return android ? `, Android ${android[1]}` : '';
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
  sendFile(res, file);
}

function sendFile(res, file) {
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
