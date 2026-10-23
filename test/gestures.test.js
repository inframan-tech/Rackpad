import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackpadRecognizer, CouchRecognizer, StripRecognizer, Velocity } from '../web/js/gestures.js';

const P = (id, x, y) => ({ id, x, y });

function trackpad(opts) {
  const out = [];
  const rec = new TrackpadRecognizer((m) => out.push(m), opts);
  return { rec, out, types: () => out.map((m) => m.t) };
}

test('a quick tap clicks', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 100)], 0);
  rec.move([P(1, 101, 101)], 40);
  rec.end([], 90);
  assert.deepEqual(out, [{ t: 'touch' }, { t: 'click', b: 'left' }]);
});

test('a long press is not a click', () => {
  const { rec, types } = trackpad();
  rec.start([P(1, 100, 100)], 0);
  rec.end([], 600);
  assert.deepEqual(types(), ['touch']);
});

test('one finger moves the pointer without losing the first few px', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 100)], 0);
  rec.move([P(1, 102, 100)], 16); // under the slop: nothing yet
  rec.move([P(1, 110, 104)], 32);
  rec.move([P(1, 120, 104)], 48);
  rec.end([], 60);
  const moves = out.filter((m) => m.t === 'move');
  assert.equal(moves.length, 2);
  assert.equal(moves[0].dx + moves[1].dx, 20);
  assert.equal(moves[0].dy + moves[1].dy, 4);
  assert.ok(!out.some((m) => m.t === 'click'), 'moving is not a click');
});

test('two-finger tap right-clicks, even when fingers land a bit apart in time', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 100)], 0);
  rec.start([P(1, 100, 100), P(2, 160, 100)], 30);
  rec.end([P(2, 160, 100)], 110);
  rec.end([], 130);
  assert.deepEqual(out.at(-1), { t: 'click', b: 'right' });
  assert.ok(!out.some((m) => m.t === 'move'));
});

test('three-finger tap is a middle click', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 100), P(2, 150, 100), P(3, 200, 100)], 0);
  rec.move([P(1, 101, 100), P(2, 151, 101), P(3, 200, 101)], 30);
  rec.end([], 120);
  assert.deepEqual(out.at(-1), { t: 'click', b: 'middle' });
});

test('two fingers scroll, and lifting mid-flick hands velocity to the Mac', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 300), P(2, 160, 300)], 0);
  let y = 300;
  for (let t = 16; t <= 160; t += 16) {
    y -= 12;
    rec.move([P(1, 100, y), P(2, 160, y)], t);
  }
  rec.end([], 170);
  const scrolls = out.filter((m) => m.t === 'scroll');
  assert.ok(scrolls.length >= 8);
  assert.ok(scrolls.every((m) => m.dy < 0 && m.dx === 0));
  const end = out.find((m) => m.t === 'scrollEnd');
  assert.ok(end.vy < -0.5, `flick velocity ${end.vy}`);
  assert.ok(!out.some((m) => m.t === 'click'));
});

test('stopping before lifting does not fling', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 300), P(2, 160, 300)], 0);
  rec.move([P(1, 100, 260), P(2, 160, 260)], 16);
  rec.move([P(1, 100, 220), P(2, 160, 220)], 32);
  rec.end([], 300); // held still for a long time, then lifted
  assert.deepEqual(out.find((m) => m.t === 'scrollEnd'), { t: 'scrollEnd', vx: 0, vy: 0 });
});

test('pinching out zooms in, pinching in zooms out', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 150, 300), P(2, 250, 300)], 0);
  rec.move([P(1, 120, 300), P(2, 280, 300)], 20); // spread 160 = 1.6x
  rec.move([P(1, 175, 300), P(2, 225, 300)], 40); // spread 50
  rec.end([], 60);
  const zooms = out.filter((m) => m.t === 'zoom').map((m) => m.steps);
  assert.ok(zooms.filter((s) => s > 0).length >= 1);
  assert.ok(zooms.filter((s) => s < 0).length >= 2);
  assert.ok(!out.some((m) => m.t === 'scroll'));
});

test('three-finger swipe up opens Mission Control (once)', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 400), P(2, 150, 400), P(3, 200, 400)], 0);
  for (let i = 1; i <= 10; i++) {
    const y = 400 - i * 15;
    rec.move([P(1, 100, y), P(2, 150, y), P(3, 200, y)], i * 16);
  }
  rec.end([], 200);
  assert.deepEqual(out.filter((m) => m.t === 'swipe'), [{ t: 'swipe', dir: 'up', fingers: 3 }]);
  assert.ok(!out.some((m) => m.t === 'click'));
});

test('tap then touch-and-move drags', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 100)], 0);
  rec.end([], 80);
  rec.start([P(1, 100, 100)], 200);
  rec.move([P(1, 130, 100)], 230);
  rec.move([P(1, 160, 100)], 260);
  rec.end([], 300);
  assert.deepEqual(out.map((m) => m.t), ['touch', 'click', 'touch', 'down', 'move', 'move', 'up']);
});

test('tap, tap is two clicks (the Mac turns it into a double-click)', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 100)], 0);
  rec.end([], 80);
  rec.start([P(1, 100, 100)], 200);
  rec.end([], 260);
  assert.equal(out.filter((m) => m.t === 'click').length, 2);
});

test('cancel releases a drag', () => {
  const { rec, out } = trackpad();
  rec.start([P(1, 100, 100)], 0);
  rec.end([], 80);
  rec.start([P(1, 100, 100)], 200);
  rec.move([P(1, 140, 100)], 230);
  rec.cancel();
  assert.equal(out.at(-1).t, 'up');
});

// ── Couch mode ────────────────────────────────────────────────────────────

function couch() {
  const out = [];
  let fire = null;
  const rec = new CouchRecognizer((m) => out.push(m), {
    setTimer: (fn) => ((fire = fn), 1),
    clearTimer: () => (fire = null),
  });
  return { rec, out, hold: () => fire?.() };
}

test('couch: tap clicks', () => {
  const { rec, out } = couch();
  rec.start([P(1, 50, 50)], 0);
  rec.end([], 100);
  assert.deepEqual(out.map((m) => m.t + (m.b ? `:${m.b}` : '')), ['touch', 'click:left']);
});

test('couch: long-press then release right-clicks', () => {
  const { rec, out, hold } = couch();
  rec.start([P(1, 50, 50)], 0);
  hold();
  rec.end([], 600);
  assert.deepEqual(out.at(-1), { t: 'click', b: 'right' });
});

test('couch: hold then move drags', () => {
  const { rec, out, hold } = couch();
  rec.start([P(1, 50, 50)], 0);
  hold();
  rec.move([P(1, 70, 50)], 500);
  rec.move([P(1, 90, 60)], 520);
  rec.end([], 540);
  assert.deepEqual(out.map((m) => m.t), ['touch', 'down', 'move', 'move', 'up']);
  const dx = out.filter((m) => m.t === 'move').reduce((s, m) => s + m.dx, 0);
  assert.equal(dx, 40);
});

test('couch: moving right away just moves (no hold, no click)', () => {
  const { rec, out, hold } = couch();
  rec.start([P(1, 50, 50)], 0);
  rec.move([P(1, 80, 50)], 30);
  hold(); // timer was cancelled; must be a no-op
  rec.end([], 600);
  assert.deepEqual(out.map((m) => m.t), ['touch', 'move']);
});

test('strip scrolls vertically and flicks', () => {
  const out = [];
  const rec = new StripRecognizer((m) => out.push(m), { gain: 1 });
  rec.start([P(1, 10, 400)], 0);
  for (let t = 16; t <= 96; t += 16) rec.move([P(1, 10, 400 - t)], t);
  rec.end([], 100);
  assert.ok(out.filter((m) => m.t === 'scroll').every((m) => m.dx === 0 && m.dy < 0));
  assert.ok(out.at(-1).vy < -0.5);
});

test('velocity averages recent samples', () => {
  const v = new Velocity();
  v.add(0, 10, 0, 16);
  v.add(16, 10, 0, 16);
  const { vx } = v.get(20);
  assert.ok(Math.abs(vx - 10 / 16) < 1e-9);
  assert.deepEqual(v.get(500), { vx: 0, vy: 0 });
});
