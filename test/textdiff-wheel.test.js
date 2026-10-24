import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText } from '../web/js/textdiff.js';
import { WheelTracker, angleDelta, zoneAt } from '../web/js/wheel.js';

// Replays a diff onto a "Mac" buffer with the caret at the end, the way the
// keystrokes would.
function apply(mac, d) {
  if (!d) return mac;
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(mac), (s) => s.segment);
  const caret = chars.length - d.left;
  const kept = chars.slice(0, caret - d.back);
  return [...kept, d.text, ...chars.slice(caret)].join('');
}

test('typing appends', () => {
  assert.deepEqual(diffText('hel', 'hello'), { left: 0, back: 0, text: 'lo' });
});

test('backspace deletes', () => {
  assert.deepEqual(diffText('hello', 'hell'), { left: 0, back: 1, text: '' });
});

test('autocorrect rewrites the last word', () => {
  const d = diffText('teh', 'the ');
  assert.equal(apply('teh', d), 'the ');
  assert.equal(d.left, 0);
});

test('dictation revising an earlier word edits in the middle', () => {
  const before = 'meet me at the cafe tomorrow';
  const after = 'meet me at the café tomorrow';
  const d = diffText(before, after);
  assert.ok(d.left > 0, 'moves the caret left');
  assert.equal(apply(before, d), after);
});

test('emoji and skin tones count as one character', () => {
  const d = diffText('ok 👍🏽', 'ok ');
  assert.deepEqual(d, { left: 0, back: 1, text: '' });
});

test('no change → null', () => {
  assert.equal(diffText('same', 'same'), null);
});

test('random edits always reproduce the target', () => {
  const alphabet = 'ab c😀é';
  let seed = 7;
  const rand = (n) => ((seed = (seed * 16807) % 2147483647) % n);
  for (let i = 0; i < 500; i++) {
    const mk = () => Array.from({ length: rand(8) }, () => [...alphabet][rand(6)]).join('');
    const a = mk();
    const b = mk();
    assert.equal(apply(a, diffText(a, b)), b, `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
});

test('angleDelta wraps around ±π', () => {
  assert.ok(Math.abs(angleDelta(Math.PI - 0.1, -Math.PI + 0.1) - 0.2) < 1e-9);
  assert.ok(Math.abs(angleDelta(-Math.PI + 0.1, Math.PI - 0.1) + 0.2) < 1e-9);
});

test('a full clockwise turn is 16 notches; turning back undoes them', () => {
  const w = new WheelTracker();
  const turn = 2 * Math.PI + 0.01;
  w.start(0);
  let steps = 0;
  for (let i = 1; i <= 100; i++) steps += w.move((turn * i) / 100);
  assert.equal(steps, 16);
  let back = 0;
  for (let i = 99; i >= 0; i--) back += w.move((turn * i) / 100);
  assert.equal(back, -16);
});

test('zones', () => {
  assert.equal(zoneAt(100, 100, 100, 100, 30, 100), 'center');
  assert.equal(zoneAt(100, 20, 100, 100, 30, 100), 'top');
  assert.equal(zoneAt(180, 100, 100, 100, 30, 100), 'right');
  assert.equal(zoneAt(100, 180, 100, 100, 30, 100), 'bottom');
  assert.equal(zoneAt(20, 100, 100, 100, 30, 100), 'left');
  assert.equal(zoneAt(300, 300, 100, 100, 30, 100), null);
});
