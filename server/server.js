// HTTP server: serves the phone app and sets up each phone's WebRTC link
// (see rtc.js), which carries everything after that: touches, keys and the
// screen. Phones prove themselves with their pairing token, and each one gets
// an input Session. With a certificate (see tls.js) the same app is served
// over HTTPS too.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { Session } from './engine.js';
import { profileFor, publicProfile } from './layouts.js';
import { tokensEqual } from './config.js';
import { renderPairPage } from './pairpage.js';
import { awdlActive } from './net.js';
import { PhoneLink, MAX_MESSAGE, shutdownLinks } from './rtc.js';

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
const MAX_STREAM_WIDTH = 1920; // px across: sharp on any phone
const STREAM_FPS = 60;
const STREAM_BITRATE = 8_000_000; // bits/s at most, while things move; a still screen sends nothing
const KEYFRAME_GAP_MS = 250; // phones asking for keyframes at once get one
const LINK_UP_MS = 15000; // a link that isn't talking by then (no answer, no route) is dropped
const MAX_PENDING = 8; // offers waiting for an answer, at most

// Third-party browser code, served straight from node_modules.
const VENDOR = new Map([['/vendor/jsQR.js', createRequire(import.meta.url).resolve('jsqr')]]);

export function createRackpadServer({ backend, token, macName, version, pairing, tls = null, log = () => {} }) {
  const clients = new Map(); // id → { link, session, name, screen, screenOff }, once the phone can talk
  const pending = new Map(); // id → client, offered but not answered yet
  const links = new Set(); // every link not closed yet, talking or not
  let lastContextKey = null;
  let securePort = null;

  const context = () => {
    const app = backend.app ?? {};
    const profile = publicProfile(profileFor(app));
    return { app: { name: app.name, bundleId: app.bundleId, icon: app.icon }, profile };
  };

  const broadcast = (msg) => {
    for (const c of clients.values()) c.link.send(msg);
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
  // One hardware encoder feeds the video track of every phone that watches.
  let streaming = null; // what the helper streams at: { maxWidth }
  let darkened = false;
  let lastKeyframe = 0;
  const watching = () => [...clients.values()].filter((c) => c.screen.on);

  function updateStream() {
    const viewers = watching();
    if (!viewers.length) {
      if (streaming) backend.send({ op: 'screen', on: false });
      streaming = null;
      return;
    }
    const maxWidth = Math.min(MAX_STREAM_WIDTH, Math.max(...viewers.map((c) => c.screen.maxWidth)));
    if (streaming?.maxWidth === maxWidth) return;
    if (streaming) backend.send({ op: 'screen', on: false }); // start again at the new size
    backend.send({ op: 'screen', on: true, maxWidth, fps: STREAM_FPS, bitrate: STREAM_BITRATE });
    streaming = { maxWidth };
  }

  function keyframe() {
    const now = performance.now();
    if (now - lastKeyframe < KEYFRAME_GAP_MS) return;
    lastKeyframe = now;
    backend.send({ op: 'keyframe' });
  }

  backend.on('frame', (frame) => {
    for (const c of watching()) c.link.frame(frame);
  });
  backend.on('screen', (state) => {
    for (const c of watching()) c.link.send({ t: 'screen', ...state });
  });

  // Screen off (dark but still drawing) while a watching phone wants it. The
  // helper gives the screen back by itself unless this is renewed.
  function updateScreenOff() {
    const want = watching().some((c) => c.screenOff);
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
    if (p === '/rtc' || p === '/rtc/answer') return handleRtc(req, res, url);

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

  // ── Phones ────────────────────────────────────────────────────────────
  // A phone POSTs to /rtc and gets the Mac's offer; it POSTs its answer to
  // /rtc/answer. Then the link connects straight across the Wi-Fi and the
  // two talk over its data channel.
  async function handleRtc(req, res, url) {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed');
    if (!tokensEqual(url.searchParams.get('k') ?? '', token)) return send(res, 401, 'application/json', JSON.stringify({ error: 'Unknown pairing code' }));
    if (url.pathname === '/rtc/answer') {
      const body = JSON.parse((await readBody(req, MAX_MESSAGE)) || '{}');
      const c = pending.get(String(body.id));
      if (!c || typeof body.sdp !== 'string') return send(res, 404, 'application/json', JSON.stringify({ error: 'No such offer' }));
      pending.delete(c.id);
      c.link.answer(body.sdp);
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (pending.size >= MAX_PENDING) return send(res, 503, 'application/json', JSON.stringify({ error: 'Too many phones connecting at once' }));
    const c = newClient(url.searchParams.get('name'), `${req.socket.remoteAddress}${platformOf(req.headers['user-agent'])}`);
    const sdp = await c.link.offer();
    if (!sdp) {
      c.link.close();
      return send(res, 500, 'application/json', JSON.stringify({ error: "WebRTC didn't start on the Mac" }));
    }
    sendJson(res, { id: c.id, sdp });
  }

  function newClient(rawName, where) {
    const name = String(rawName ?? 'Phone').slice(0, 40);
    const c = { id: randomUUID(), name, screen: { on: false, maxWidth: 1280 }, screenOff: false, session: null };
    c.link = new PhoneLink({
      onOpen: () => onOpen(c, where),
      onMessage: (msg) => onMessage(c, msg),
      onClose: () => onClose(c),
      keyframe,
      log: backend.verbose ? (m) => log(`${name}: ${m}`) : () => {},
      onError: (m) => log(`${name}: ${m}`),
    });
    pending.set(c.id, c);
    links.add(c.link);
    c.upTimer = setTimeout(() => c.link.close(), LINK_UP_MS);
    return c;
  }

  function onOpen(c, where) {
    clearTimeout(c.upTimer);
    c.session = new Session({
      backend,
      onVolume: (v) => c.link.send({ t: 'volume', ...v }),
      onStats: backend.verbose ? (st) => log(`glide: ${st.moves} moves in 3s, ${st.late} late, playing ${st.buffer} ms behind`) : null,
    });
    clients.set(c.id, c);
    log(`📱 ${c.name} connected (${where})`);
    const secure = securePort ? { port: securePort, ca: tls.caName } : null;
    c.link.send({ t: 'welcome', version, mac: { name: macName }, backend: backend.status, secure, ...context() });
  }

  function onMessage(c, msg) {
    if (msg.t === 'ping') {
      c.link.send({ t: 'pong', id: msg.id });
      return;
    }
    if (msg.t === 'screen') {
      c.screen.on = msg.on === true;
      c.screen.maxWidth = Math.round(Math.min(MAX_STREAM_WIDTH, Math.max(320, Number(msg.maxWidth) || 1280)));
      c.link.watch(c.screen.on);
      updateStream();
      updateScreenOff();
      return;
    }
    if (msg.t === 'screenOff') {
      c.screenOff = msg.on === true;
      updateScreenOff();
      return;
    }
    try {
      c.session?.handle(msg);
    } catch (err) {
      log(`Bad message ${JSON.stringify(msg).slice(0, 200)}: ${err.message}`);
    }
  }

  function onClose(c) {
    clearTimeout(c.upTimer);
    pending.delete(c.id);
    links.delete(c.link);
    if (!clients.delete(c.id)) return; // never got as far as talking
    c.session?.dispose();
    updateStream();
    updateScreenOff();
    log(`📱 ${c.name} disconnected`);
  }

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
      clearInterval(renewScreenOff);
      for (const link of [...links]) link.close();
      shutdownLinks();
      const closing = [server, secureServer].filter((srv) => srv?.listening).map((srv) => new Promise((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      }));
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
