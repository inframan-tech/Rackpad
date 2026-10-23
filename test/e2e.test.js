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
let backend, server, port, browser, page, cdp;

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
  server = createRackpadServer({
    backend,
    token: TOKEN,
    macName: 'Test Mac',
    version: '0.0.0-test',
    pairing: { primary: `http://test.local:1/?k=${TOKEN}`, fallbacks: [] },
  });
  port = await server.listen(0, '127.0.0.1');
  browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ ...pw.devices['iPhone 14 Pro'] });
  await ctx.addInitScript(() => localStorage.setItem('rackpad.installTipShown', 'true'));
  page = await ctx.newPage();
  cdp = await ctx.newCDPSession(page);
  await page.goto(`http://127.0.0.1:${port}/?k=${TOKEN}`);
  await page.waitForFunction(() => document.querySelector('#conn').dataset.state === 'open');
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const skip = !pw && 'Playwright not installed';

test('connects, names the Mac, and pushes settings to the helper', { skip }, async () => {
  assert.equal(await page.textContent('#mac-name'), 'Test Mac');
  await waitFor(() => opsOf('config').length > 0);
  assert.equal(opsOf('config').at(-1).color, '#00e5ff');
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
  await waitFor(() => opsOf('move').length >= 5);
  const dx = opsOf('move').reduce((s, o) => s + o.dx, 0);
  assert.ok(dx > 108, `moved ${dx}`);
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

test('couch mode: hold then release right-clicks', { skip }, async () => {
  await show('couch');
  reset();
  const [x, y] = await center('#couch');
  await touch('touchStart', [[x, y]]);
  await sleep(550);
  await touch('touchEnd', []);
  await waitFor(() => opsOf('button').length === 2);
  assert.equal(opsOf('button')[0].b, 'right');
});

test('couch mode: the strip scrolls', { skip }, async () => {
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
  await show('wheel');
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
  await page.waitForFunction(() => document.querySelector('#tab-app-label').textContent === 'Zoom');
  await show('app');
  reset();
  await page.locator('.hero-btn').click();
  await waitFor(() => opsOf('key').length === 1);
  assert.deepEqual(opsOf('key')[0], { op: 'key', code: 0, char: 'a', mods: ['cmd', 'shift'] });

  backend.setApp({ bundleId: 'com.apple.Safari', name: 'Safari', title: 'Docs' });
  await page.waitForFunction(() => document.querySelector('#tab-app-label').textContent === 'Browser');
  await page.locator('.tile', { hasText: 'Address bar' }).click();
  await page.waitForFunction(() => document.querySelector('section[data-view="keys"]').classList.contains('active'));
});

test('a wrong pairing code shows the pairing screen', { skip }, async () => {
  const p2 = await browser.newPage();
  await p2.goto(`http://127.0.0.1:${port}/?k=wrong-token-123456789`);
  await p2.waitForSelector('#pairing:not([hidden])');
  assert.match(await p2.textContent('#pairing-msg'), /no longer valid/);
  await p2.close();
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
  assert.equal(JSON.parse((await get('/manifest.webmanifest?k=nope')).body).start_url, '/');
});
