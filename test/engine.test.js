import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, Momentum, pointerGain } from '../server/engine.js';
import { parseCombo, resolveKey } from '../server/keys.js';
import { profileFor, publicProfile, findControl, PROFILES } from '../server/layouts.js';
import { parseVolumeSettings } from '../server/backend.js';

function session() {
  let t = 1000;
  const ops = [];
  const timers = [];
  const s = new Session({
    backend: { send: (op) => ops.push(op), volume: async () => ({ level: 40, muted: false }) },
    now: () => t,
    setInterval: (fn) => (timers.push(fn), timers.length),
    clearInterval: () => timers.splice(0),
  });
  return {
    s,
    ops,
    advance(ms) {
      t += ms;
    },
    runMomentum(ms = 3000) {
      for (let i = 0; i < ms / 8 && timers.length; i++) {
        t += 8;
        timers[0]();
      }
    },
    timers,
  };
}

test('pointer gain is gentle when slow, strong when fast, and monotonic', () => {
  assert.ok(pointerGain(0.02) < 1.3);
  assert.ok(pointerGain(3) > 4);
  let prev = 0;
  for (let v = 0; v < 4; v += 0.05) {
    const g = pointerGain(v);
    assert.ok(g >= prev);
    prev = g;
  }
  assert.ok(Math.abs(pointerGain(1, 2) - 2 * pointerGain(1, 1)) < 1e-9);
});

test('move sends accelerated relative motion', () => {
  const { s, ops } = session();
  s.handle({ t: 'move', dx: 10, dy: 0, dt: 16 });
  assert.equal(ops[0].op, 'move');
  assert.ok(ops[0].dx > 10);
  assert.equal(ops[0].dy, 0);
});

test('two quick clicks in place become a double-click', () => {
  const h = session();
  h.s.handle({ t: 'click', b: 'left' });
  h.advance(200);
  h.s.handle({ t: 'click', b: 'left' });
  const downs = h.ops.filter((o) => o.op === 'button' && o.down);
  assert.deepEqual(downs.map((o) => o.n), [1, 2]);
});

test('clicks far apart in time or space stay single', () => {
  const h = session();
  h.s.handle({ t: 'click', b: 'left' });
  h.advance(800);
  h.s.handle({ t: 'click', b: 'left' });
  h.advance(100);
  h.s.handle({ t: 'move', dx: 30, dy: 0, dt: 16 });
  h.s.handle({ t: 'click', b: 'left' });
  const downs = h.ops.filter((o) => o.op === 'button' && o.down);
  assert.deepEqual(downs.map((o) => o.n), [1, 1, 1]);
});

test('natural scrolling follows the fingers; turning it off reverses', () => {
  const h = session();
  h.s.handle({ t: 'scroll', dx: 0, dy: 10 });
  assert.ok(h.ops[0].dy > 0);
  h.s.handle({ t: 'settings', naturalScroll: false });
  h.s.handle({ t: 'scroll', dx: 0, dy: 10 });
  assert.ok(h.ops[1].dy < 0);
});

test('fractional scroll deltas are carried, not lost', () => {
  const h = session();
  for (let i = 0; i < 100; i++) h.s.handle({ t: 'scroll', dx: 0, dy: 0.25 });
  const total = h.ops.reduce((sum, o) => sum + o.dy, 0);
  assert.equal(total, 40); // 100 × 0.25 × 1.6
});

test('momentum glides after a flick, slows down and stops', () => {
  const h = session();
  h.s.handle({ t: 'scrollEnd', vx: 0, vy: 2 });
  assert.equal(h.timers.length, 1);
  h.runMomentum();
  const deltas = h.ops.map((o) => o.dy);
  assert.ok(deltas.length > 20);
  assert.ok(deltas[0] >= deltas.at(-1));
  assert.equal(h.timers.length, 0, 'timer cleared when the glide ends');
  const total = deltas.reduce((a, b) => a + b, 0);
  assert.ok(total > 1000 && total < 2000, `glide distance ${total}`);
});

test('touching the phone stops the glide and swallows the stopping tap', () => {
  const h = session();
  h.s.handle({ t: 'scrollEnd', vx: 0, vy: 3 });
  h.runMomentum(80);
  h.s.handle({ t: 'touch' });
  assert.equal(h.timers.length, 0);
  h.s.handle({ t: 'click', b: 'left' });
  assert.ok(!h.ops.some((o) => o.op === 'button'));
  h.advance(400);
  h.s.handle({ t: 'click', b: 'left' });
  assert.ok(h.ops.some((o) => o.op === 'button'));
});

test('momentum integrates exactly regardless of frame rate', () => {
  const a = new Momentum();
  const b = new Momentum();
  a.start(0, 1, 0);
  b.start(0, 1, 0);
  let da = 0, db = 0;
  for (let t = 4; t <= 400; t += 4) da += a.step(t)?.dy ?? 0;
  for (let t = 16; t <= 400; t += 16) db += b.step(t)?.dy ?? 0;
  assert.ok(Math.abs(da - db) < 0.5, `${da} vs ${db}`);
});

test('pinch steps become Cmd+= / Cmd+-', () => {
  const h = session();
  h.s.handle({ t: 'zoom', steps: 2 });
  h.s.handle({ t: 'zoom', steps: -1 });
  assert.deepEqual(h.ops.map((o) => [o.char, o.mods]), [['=', ['cmd']], ['=', ['cmd']], ['-', ['cmd']]]);
});

test('three-finger swipes map like a Mac trackpad', () => {
  const h = session();
  for (const dir of ['up', 'down', 'left', 'right']) h.s.handle({ t: 'swipe', dir });
  assert.deepEqual(h.ops[0], { op: 'missionControl' });
  assert.deepEqual([h.ops[1].code, h.ops[1].mods], [125, ['ctrl']]);
  assert.deepEqual([h.ops[2].code, h.ops[2].mods], [124, ['ctrl']]); // swipe left → desktop to the right
  assert.deepEqual([h.ops[3].code, h.ops[3].mods], [123, ['ctrl']]);
});

test('typing edits expand to arrows, backspaces and text', () => {
  const h = session();
  h.s.handle({ t: 'type', left: 3, back: 2, text: 'é' });
  assert.deepEqual(h.ops, [
    { op: 'key', code: 123, mods: [], n: 3 },
    { op: 'key', code: 51, mods: [], n: 2 },
    { op: 'text', s: 'é' },
    { op: 'key', code: 124, mods: [], n: 3 },
  ]);
});

test('key messages validate modifiers and keys', () => {
  const h = session();
  h.s.handle({ t: 'key', k: 'c', mods: ['cmd', 'bogus'] });
  h.s.handle({ t: 'key', k: 'nope' });
  h.s.handle({ t: 'key', k: 'left', n: 5 });
  assert.deepEqual(h.ops, [
    { op: 'key', code: 8, mods: ['cmd'], char: 'c' },
    { op: 'key', code: 123, mods: [], n: 5 },
  ]);
});

test('the click wheel steps the volume and reports the level back', async () => {
  const levels = [];
  const ops = [];
  const s = new Session({ backend: { send: (o) => ops.push(o), volume: async () => ({ level: 62, muted: false }) }, onVolume: (v) => levels.push(v) });
  s.handle({ t: 'wheel', steps: 3 });
  s.handle({ t: 'wheel', steps: -1 });
  assert.deepEqual(ops.map((o) => o.k), ['volup', 'volup', 'volup', 'voldown']);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(levels, [{ level: 62, muted: false }], 'debounced to one query');
  s.dispose();
});

test('smart layout actions run their shortcut', () => {
  const h = session();
  h.s.handle({ t: 'action', id: 'zoom.mute' });
  h.s.handle({ t: 'action', id: 'music.play' });
  h.s.handle({ t: 'action', id: 'default.mission' });
  h.s.handle({ t: 'action', id: 'nope.nope' });
  assert.deepEqual(h.ops[0], { op: 'key', code: 0, char: 'a', mods: ['cmd', 'shift'] });
  assert.deepEqual(h.ops[1], { op: 'media', k: 'playpause' });
  assert.deepEqual(h.ops[2], { op: 'missionControl' });
  assert.equal(h.ops.length, 3);
});

test('settings forward beacon, ripples and theme colours to the helper', () => {
  const h = session();
  h.s.handle({ t: 'settings', beacon: false, ripples: true, accent: '#00e5ff', accent2: 'red' });
  assert.deepEqual(h.ops, [{ op: 'config', beacon: false, ripples: true, color: '#00e5ff' }]);
});

test('disconnecting mid-drag releases the button', () => {
  const h = session();
  h.s.handle({ t: 'down', b: 'left' });
  h.s.dispose();
  assert.deepEqual(h.ops.at(-1), { op: 'button', b: 'left', down: false, n: 1 });
});

test('garbage input is ignored', () => {
  const h = session();
  for (const m of [null, {}, { t: 42 }, { t: 'move', dx: 'x', dy: NaN }, { t: 'move', dx: Infinity, dy: 0 }, { t: 'type', text: 5 }]) h.s.handle(m);
  assert.deepEqual(h.ops, []);
});

// ── Keys ──────────────────────────────────────────────────────────────────

test('parseCombo', () => {
  assert.deepEqual(parseCombo('cmd+shift+t'), { code: 17, char: 't', mods: ['cmd', 'shift'] });
  assert.deepEqual(parseCombo('ctrl+shift+tab'), { code: 48, mods: ['ctrl', 'shift'] });
  assert.deepEqual(parseCombo('cmd+{'), { code: 33, char: '[', mods: ['cmd', 'shift'] });
  assert.deepEqual(parseCombo('cmd++'), { code: 24, char: '=', mods: ['cmd', 'shift'] });
  assert.deepEqual(parseCombo('space'), { code: 49, mods: [] });
  assert.throws(() => parseCombo('hyper+x'));
  assert.throws(() => parseCombo('cmd+nope'));
});

test('resolveKey handles capitals and names', () => {
  assert.deepEqual(resolveKey('A'), { code: 0, char: 'a', shift: true });
  assert.deepEqual(resolveKey('Return'), { code: 36, shift: false });
  assert.equal(resolveKey('é'), null);
});

test('every smart layout shortcut parses', () => {
  for (const p of PROFILES) for (const c of p.controls) if (c.keys) assert.doesNotThrow(() => parseCombo(c.keys), `${p.id}.${c.id}`);
});

// ── Layouts ───────────────────────────────────────────────────────────────

test('smart layouts follow the front app', () => {
  assert.equal(profileFor({ bundleId: 'us.zoom.xos' }).id, 'zoom');
  assert.equal(profileFor({ bundleId: 'com.apple.iWork.Keynote' }).id, 'keynote');
  assert.equal(profileFor({ bundleId: 'com.google.Chrome', title: 'Meet - abc-defg-hij' }).id, 'meet');
  assert.equal(profileFor({ bundleId: 'com.apple.Safari', title: 'Lo-fi beats - YouTube' }).id, 'youtube');
  assert.equal(profileFor({ bundleId: 'com.apple.Safari', title: 'Meeting notes' }).id, 'browser');
  assert.equal(profileFor({ bundleId: 'com.apple.finder' }).id, 'default');
  assert.equal(profileFor(undefined).id, 'default');
});

test('public profiles are namespaced and resolvable', () => {
  for (const p of PROFILES) {
    const pub = publicProfile(p);
    for (const c of pub.controls) assert.ok(findControl(c.id), c.id);
    for (const id of pub.strip) assert.ok(pub.controls.some((c) => c.id === id), id);
    assert.ok(pub.controls.every((c) => !('keys' in c) && !('media' in c) && !('sys' in c)), 'what a control does stays on the Mac');
  }
});

test('parses osascript volume output', () => {
  assert.deepEqual(parseVolumeSettings('output volume:44, input volume:75, alert volume:100, output muted:false'), { level: 44, muted: false });
  assert.deepEqual(parseVolumeSettings('output volume:0, input volume:75, alert volume:100, output muted:true'), { level: 0, muted: true });
  assert.equal(parseVolumeSettings('output volume:missing value, output muted:missing value'), null);
});
