// End to end: the real phone page in Chromium (emulating an iPhone, with
// real touch events) talking to the real server, with a dry-run backend that
// records what the Mac would have been told to do.
//
// Needs Playwright; skipped if it isn't installed (npm i -D playwright).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import { X509Certificate } from 'node:crypto';
import QRCode from 'qrcode';
import { ensureTls } from '../server/tls.js';
import { createRackpadServer } from '../server/server.js';
import { DryRunBackend } from '../server/backend.js';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    try {
      return require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));
    } catch {
      return null;
    }
  }
}

const pw = loadPlaywright();
const TOKEN = 'e2e-token-abcdefghijkl';
let backend, server, port, securePort, browser, page, cdp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opsOf = (kind) => backend.ops.filter((o) => o.op === kind);
const reset = () => (backend.ops.length = 0);

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${fn}`);
}

// Multi-finger touches straight through the DevTools protocol.
async function touch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

async function gesture(frames, stepMs = 16) {
  await touch('touchStart', frames[0]);
  for (const f of frames.slice(1)) {
    await sleep(stepMs);
    await touch('touchMove', f);
  }
  await touch('touchEnd', []);
}

// Let a scroll glide from an earlier test die down: a touch during a glide
// only stops it (like grabbing a scrolling list), it doesn't click.
async function settle() {
  let seen = -1;
  while (seen !== backend.ops.length) {
    seen = backend.ops.length;
    await sleep(150);
  }
}

async function center(sel) {
  const b = await page.locator(sel).boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2, b];
}

async function show(view) {
  await page.evaluate((v) => window.rackpad.showView(v), view);
  await sleep(50);
}

before(async () => {
  if (!pw) return;
  backend = new DryRunBackend();
  const tls = ensureTls({ hostName: 'test', ips: [], dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rackpad-e2e-tls-')) });
  server = createRackpadServer({
    backend,
    token: TOKEN,
    macName: 'Test Mac',
    version: '0.0.0-test',
    pairing: { primary: `http://test.local:1/?k=${TOKEN}`, fallbacks: [] },
    tls,
  });
  port = await server.listen(0, '127.0.0.1');
  securePort = await server.listenSecure(0, '127.0.0.1');
  browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ ...pw.devices['iPhone 14 Pro'] });
  await ctx.addInitScript(() => localStorage.setItem('rackpad.installTipShown', 'true'));
  page = await ctx.newPage();
  cdp = await ctx.newCDPSession(page);
  await page.goto(`http://127.0.0.1:${port}/?k=${TOKEN}`);
  await page.waitForFunction(() => document.querySelector('#presence').dataset.state === 'open');
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const skip = !pw && 'Playwright not installed';

test('connects, names the Mac, and pushes settings to the helper', { skip }, async () => {
  assert.equal(await page.textContent('#mac-name'), 'Test Mac');
  await page.waitForFunction(() => /^\d+ ms$/.test(document.querySelector('#ping-ms').textContent));
  assert.equal(await page.getAttribute('#ping', 'data-level'), 'ok', 'a local round trip is quick');
  await waitFor(() => opsOf('config').length > 0);
  assert.equal(opsOf('config').at(-1).color, '#64d2ff');
});

test('tap on the trackpad clicks; two taps double-click', { skip }, async () => {
  await show('pad');
  reset();
  const [x, y] = await center('#pad');
  await gesture([[[x, y]]]);
  await sleep(120);
  await gesture([[[x, y]]]);
  await waitFor(() => opsOf('button').length === 4);
  assert.deepEqual(opsOf('button').map((o) => `${o.b}:${o.down ? 'down' : 'up'}:${o.n}`), ['left:down:1', 'left:up:1', 'left:down:2', 'left:up:2']);
});

test('one finger moves the pointer', { skip }, async () => {
  await sleep(400); // right after a tap, touch-and-move would be a drag
  reset();
  const [x, y] = await center('#pad');
  await gesture(Array.from({ length: 10 }, (_, i) => [[x - 60 + i * 12, y]]));
  // Movement plays a few ms behind the finger, so wait for all of it.
  await waitFor(() => opsOf('move').reduce((s, o) => s + o.dx, 0) > 108);
  assert.equal(opsOf('button').length, 0);
});

test('two-finger tap right-clicks; two-finger drag scrolls', { skip }, async () => {
  reset();
  const [x, y] = await center('#pad');
  await gesture([[[x - 30, y], [x + 30, y]]]);
  await waitFor(() => opsOf('button').length === 2);
  assert.equal(opsOf('button')[0].b, 'right');

  reset();
  await gesture(Array.from({ length: 10 }, (_, i) => [[x - 30, y + 100 - i * 20], [x + 30, y + 100 - i * 20]]));
  await waitFor(() => opsOf('scroll').length >= 5);
  assert.ok(opsOf('scroll').every((o) => o.dy < 0), 'natural scrolling: fingers up, content up');
});

test('three-finger swipe up opens Mission Control', { skip }, async () => {
  reset();
  const [x, y] = await center('#pad');
  await gesture(Array.from({ length: 8 }, (_, i) => [[x - 50, y + 80 - i * 18], [x, y + 80 - i * 18], [x + 50, y + 80 - i * 18]]));
  await waitFor(() => opsOf('missionControl').length === 1);
});

test('holding still, then letting go, right-clicks', { skip }, async () => {
  reset();
  const [x, y] = await center('#pad');
  await touch('touchStart', [[x, y]]);
  await sleep(550);
  await touch('touchEnd', []);
  await waitFor(() => opsOf('button').length === 2);
  assert.equal(opsOf('button')[0].b, 'right');
});

test('the edge strip scrolls with one thumb', { skip }, async () => {
  reset();
  const [x, y] = await center('#strip');
  await gesture(Array.from({ length: 8 }, (_, i) => [[x, y - 80 + i * 20]]));
  await waitFor(() => opsOf('scroll').length >= 4);
  assert.ok(opsOf('scroll').every((o) => o.dx === 0 && o.dy > 0));
});

test('live typing mirrors the field, including corrections', { skip }, async () => {
  await show('keys');
  reset();
  const field = page.locator('#type-field');
  await field.focus();
  await page.keyboard.type('helo');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('lo');
  // Simulate autocorrect replacing the whole word at once.
  await field.evaluate((el) => {
    el.value = 'Hello ';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await waitFor(() => opsOf('text').length >= 6);
  // Replay what the Mac would end up with.
  let mac = '';
  for (const o of backend.ops) {
    if (o.op === 'text') mac += o.s;
    if (o.op === 'key' && o.code === 51) mac = mac.slice(0, -(o.n ?? 1));
  }
  assert.equal(mac, 'Hello ');
  reset();
  await page.keyboard.press('Enter');
  await waitFor(() => opsOf('key').length === 1);
  assert.equal(opsOf('key')[0].code, 36);
  assert.equal(await field.inputValue(), '', 'field resets after Return');
});

test('sticky ⌘ turns the next letter into a shortcut', { skip }, async () => {
  reset();
  const [x, y] = await center('[data-mod="cmd"]');
  await gesture([[[x, y]]]);
  await page.keyboard.type('c');
  await waitFor(() => opsOf('key').length === 1);
  assert.deepEqual(opsOf('key')[0], { op: 'key', code: 8, mods: ['cmd'], char: 'c' });
  assert.equal(opsOf('text').length, 0);
});

test('turning the click wheel clockwise turns the volume up', { skip }, async () => {
  await show('remote');
  reset();
  const [cx, cy, box] = await center('#wheel');
  const r = box.width * 0.4;
  const frames = [];
  for (let a = -Math.PI / 2; a <= Math.PI / 2; a += Math.PI / 24) frames.push([[cx + Math.cos(a) * r, cy + Math.sin(a) * r]]);
  await gesture(frames);
  await waitFor(() => opsOf('media').length >= 7);
  assert.ok(opsOf('media').every((o) => o.k === 'volup'));
  await page.waitForFunction(() => document.querySelector('#vol-pct').textContent !== '–');
});

test('tapping the wheel centre plays/pauses', { skip }, async () => {
  reset();
  const [cx, cy] = await center('#wheel');
  await gesture([[[cx, cy]]]);
  await waitFor(() => opsOf('media').length === 1);
  assert.equal(opsOf('media')[0].k, 'playpause');
});

test('smart layout follows the front app and its buttons work', { skip }, async () => {
  backend.setApp({ bundleId: 'us.zoom.xos', name: 'zoom.us' });
  await page.waitForFunction(() => document.querySelector('#smart-panel').dataset.profile === 'zoom');
  await show('app');
  reset();
  await page.locator('.hero-btn').click();
  await waitFor(() => opsOf('key').length === 1);
  assert.deepEqual(opsOf('key')[0], { op: 'key', code: 0, char: 'a', mods: ['cmd', 'shift'] });

  backend.setApp({ bundleId: 'com.apple.Safari', name: 'Safari', title: 'Docs' });
  await page.waitForFunction(() => document.querySelector('#smart-panel').dataset.profile === 'browser');
  await page.locator('.tile', { hasText: 'Address bar' }).click();
  await page.waitForFunction(() => document.querySelector('section[data-view="keys"]').classList.contains('active'));
});

test('sideways, the whole phone is the trackpad', { skip }, async () => {
  await show('keys');
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForFunction(() => document.body.classList.contains('magic'));
  assert.equal(await page.locator('#dock').isVisible(), false);
  assert.equal(await page.locator('section[data-view="pad"]').isVisible(), true);
  await settle();
  reset();
  const [x, y] = await center('#pad');
  await gesture([[[x, y]]]);
  await waitFor(() => opsOf('button').length === 2);

  // The space beside the glass holds the scroll strip…
  const [sx, sy, strip] = await center('#strip');
  assert.ok(strip.x + strip.width >= 852 - 1, 'the strip sits at the edge, outside the glass');
  reset();
  await gesture(Array.from({ length: 6 }, (_, i) => [[sx, sy - 50 + i * 20]]));
  await waitFor(() => opsOf('scroll').length >= 3);

  // …and the keyboard key, which swaps the glass for typing and back.
  await page.locator('#side-key').click();
  await page.waitForFunction(() => document.querySelector('section[data-view="keys"]').classList.contains('active'));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'type-field');
  reset();
  await page.keyboard.type('hi');
  await waitFor(() => opsOf('text').length === 2);
  await page.locator('#side-key').click();
  await page.waitForFunction(() => document.querySelector('section[data-view="pad"]').classList.contains('active'));

  await page.setViewportSize({ width: 393, height: 660 });
  await page.waitForFunction(() => !document.body.classList.contains('magic'));
  assert.equal(await page.locator('section[data-view="keys"]').isVisible(), true, 'back to where you were');
});

test('touching the phone keeps the Wi-Fi link warm; idle, it goes quiet', { skip }, async () => {
  await show('pad');
  const pings = () => page.evaluate(() => window.rackpad.conn.pingId);
  await page.evaluate(() => (window.rackpad.conn.lastUse = -Infinity)); // as if untouched for a while
  let before = await pings();
  await sleep(400);
  assert.ok((await pings()) - before <= 1, 'idle: a ping every 2 s at most');
  const [x, y] = await center('#pad');
  await settle();
  await gesture([[[x, y]]]);
  before = await pings();
  await sleep(400);
  const warm = (await pings()) - before;
  assert.ok(warm >= 12, `in use: a ping every 20 ms (${warm} in 400 ms)`);
  assert.match(await page.textContent('#ping-ms'), /^\d+ ms$/);
});

test('a fresh Home Screen app pairs itself from a photo of the QR code', { skip }, async () => {
  const ctx = await browser.newContext({ ...pw.devices['iPhone 14 Pro'] });
  const phone = await ctx.newPage();
  await phone.goto(`http://127.0.0.1:${port}/`); // no token, no storage
  await phone.waitForSelector('#pairing:not([hidden])');

  // A photo with no code in it.
  const icon = await (await fetch(`http://127.0.0.1:${port}/icons/icon-192.png`)).arrayBuffer();
  await phone.setInputFiles('#scan-input', { name: 'IMG_0001.png', mimeType: 'image/png', buffer: Buffer.from(icon) });
  await phone.waitForFunction(() => /doesn't show a Rackpad code/.test(document.querySelector('#pairing-msg').textContent));

  // A photo of the Mac's QR code.
  const qr = await QRCode.toBuffer(`http://test.local:${port}/?k=${TOKEN}`, { scale: 8, margin: 4 });
  await phone.setInputFiles('#scan-input', { name: 'IMG_0002.png', mimeType: 'image/png', buffer: qr });
  await phone.waitForFunction(() => document.querySelector('#presence').dataset.state === 'open');
  assert.equal(new URL(phone.url()).searchParams.get('k'), TOKEN);
  assert.equal(await phone.evaluate(() => JSON.parse(localStorage.getItem('rackpad.token'))), TOKEN);
  await ctx.close();
});

test('a wrong pairing code shows the pairing screen', { skip }, async () => {
  const p2 = await browser.newPage();
  await p2.goto(`http://127.0.0.1:${port}/?k=wrong-token-123456789`);
  await p2.waitForSelector('#pairing:not([hidden])');
  assert.match(await p2.textContent('#pairing-msg'), /no longer valid/);
  await p2.close();
});

test('the plain page offers secure setup, and waits until the phone trusts the certificate', { skip }, async () => {
  await page.waitForFunction(() => document.querySelector('#secure-state').textContent === 'Set up');
  await page.evaluate(() => document.querySelector('#open-secure').click());
  await page.waitForSelector('#secure:not([hidden])');
  // This test browser doesn't trust Rackpad's authority, so the secure page can't answer yet.
  await page.waitForFunction(() => document.querySelector('#secure-open').textContent === 'Check again');
  assert.equal(await page.getAttribute('#secure-download', 'href'), '/rackpad.crt');
  await page.evaluate(() => document.querySelector('#secure-done').click());
});

test('over HTTPS the same app connects securely and works', { skip }, async () => {
  const ctx = await browser.newContext({ ...pw.devices['iPhone 14 Pro'], ignoreHTTPSErrors: true }); // as if the phone trusts it
  await ctx.addInitScript(() => localStorage.setItem('rackpad.installTipShown', 'true'));
  const phone = await ctx.newPage();
  const phoneCdp = await ctx.newCDPSession(phone);
  await phone.goto(`https://127.0.0.1:${securePort}/?k=${TOKEN}`);
  await phone.waitForFunction(() => document.querySelector('#presence').dataset.state === 'open');
  assert.equal(await phone.textContent('#secure-state'), 'On');
  assert.equal(await phone.evaluate(() => window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia), 'function', 'the mic and camera are offered now');
  await settle();
  reset();
  const b = await phone.locator('#pad').boundingBox();
  const at = [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 0 }];
  await phoneCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
  await phoneCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(() => opsOf('button').length === 2);
  await ctx.close();
});

function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('server: static files are confined, pairing page is Mac-only', { skip }, async () => {
  assert.equal((await get('/../package.json')).status, 404);
  assert.equal((await get('/%2e%2e/package.json')).status, 404);
  assert.equal((await get('/js/main.js')).status, 200);
  assert.equal((await get('/pair', { host: 'evil.example' })).status, 403);
  const pair = await get('/pair', { host: `localhost:${port}` });
  assert.equal(pair.status, 200);
  assert.match(pair.body, /<svg/);
  const manifest = JSON.parse((await get(`/manifest.webmanifest?k=${TOKEN}`)).body);
  assert.equal(manifest.start_url, `/?k=${TOKEN}`);
  assert.equal(manifest.orientation, 'any');
  // Without a token, start_url defaults to the address of the page that linked the manifest.
  assert.equal(JSON.parse((await get('/manifest.webmanifest?k=nope')).body).start_url, undefined);
  // The page links the manifest with the token from the start, so the Home Screen icon opens paired.
  assert.match((await get(`/?k=${TOKEN}`)).body, new RegExp(`href="/manifest\\.webmanifest\\?k=${TOKEN}"`));
  assert.match((await get('/?k=nope')).body, /href="\/manifest\.webmanifest"/);
  assert.equal((await get('/vendor/jsQR.js')).status, 200);
  assert.equal((await get('/vendor/__proto__')).status, 404);

  // The authority the phone installs, served as a certificate (DER).
  const ca = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/rackpad.crt' }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ type: res.headers['content-type'], body: Buffer.concat(parts) }));
    }).on('error', reject);
  });
  assert.equal(ca.type, 'application/x-x509-ca-cert');
  assert.match(new X509Certificate(ca.body).subject, /Rackpad Local CA/);
  assert.equal(JSON.parse((await get('/secure-check')).body).secure, false);
  const secureCheck = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: securePort, path: '/secure-check', rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
  assert.equal(secureCheck.secure, true);
});
