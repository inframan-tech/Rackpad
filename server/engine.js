// Turns phone gestures into native input commands for the Mac helper.
//
// The phone sends raw finger deltas; everything that makes it *feel* like a
// Mac trackpad lives here, where it can be tested: pointer acceleration,
// double-click detection, scroll momentum that keeps gliding after the
// finger lifts, and playback that smooths out Wi-Fi's uneven delivery.

import { parseCombo, resolveKey, cleanMods } from './keys.js';
import { findControl } from './layouts.js';

export const DEFAULT_SETTINGS = {
  pointerSpeed: 1,
  scrollSpeed: 1,
  naturalScroll: true,
};

const DOUBLE_CLICK_MS = 450;
const DOUBLE_CLICK_SLOP = 8; // Mac points the pointer may drift between clicks
const MOMENTUM_TICK_MS = 8;
const GLIDE_TICK_MS = 4; // how often queued movement is played out (250 Hz)
const MAX_SEGMENT_MS = 34; // a move is spread over at most two phone frames
const SCROLL_GAIN = 1.6;
const MAX_DELTA = 4000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, lo = -MAX_DELTA, hi = MAX_DELTA) => (Number.isFinite(v) ? clamp(v, lo, hi) : 0);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Gain applied to a finger movement, given its speed in phone px per ms.
// Slow movements map ~1:1 for precision; fast flicks cross the screen.
export function pointerGain(speed, setting = 1) {
  return setting * (1.1 + 3.1 * smoothstep(0.04, 1.6, speed));
}

// Exponential-decay glide, the same curve iOS uses for scroll views.
export class Momentum {
  constructor({ decay = 0.998, minSpeed = 0.012, maxSpeed = 9 } = {}) {
    this.decay = decay;
    this.minSpeed = minSpeed;
    this.maxSpeed = maxSpeed;
    this.active = false;
  }

  start(vx, vy, t) {
    const speed = Math.hypot(vx, vy);
    if (!(speed > this.minSpeed)) return this.stop();
    const k = speed > this.maxSpeed ? this.maxSpeed / speed : 1;
    this.vx = vx * k;
    this.vy = vy * k;
    this.t = t;
    this.active = true;
  }

  // Distance travelled since the last step (exact integral of the decay).
  step(t) {
    if (!this.active) return null;
    const dt = clamp(t - this.t, 0, 50);
    this.t = t;
    const f = Math.pow(this.decay, dt);
    const k = (1 - f) / -Math.log(this.decay);
    const out = { dx: this.vx * k, dy: this.vy * k };
    this.vx *= f;
    this.vy *= f;
    if (Math.hypot(this.vx, this.vy) < this.minSpeed) this.active = false;
    return out;
  }

  stop() {
    this.active = false;
  }
}

// When to play a finger event on the Mac. A Bluetooth mouse feels smooth
// because its reports arrive on a steady beat; Wi-Fi delivers the phone's
// messages in clumps instead. So each event carries the phone's timestamp and
// starts playing a fixed delay after it happened: the network's quickest trip
// (learned from recent messages) plus how much later than that most messages
// arrive. A straggler later than that plays the moment it lands.
export class Playout {
  constructor({ windowMs = 1500, pauseMs = 800, minBuffer = 2, maxBuffer = 45, startBuffer = 10 } = {}) {
    this.windowMs = windowMs;
    this.pauseMs = pauseMs;
    this.minBuffer = minBuffer;
    this.maxBuffer = maxBuffer;
    this.startBuffer = startBuffer;
    this.samples = []; // { at, lag }: when a message arrived, and arrival minus phone time
    this.buffer = startBuffer;
  }

  // `ts` is on the phone's clock, `now` on ours; returns when (on ours) to start playing.
  when(ts, now) {
    const s = this.samples;
    // After a pause the phone may have slept and its clock with it: start over.
    if (s.length && now - s[s.length - 1].at > this.pauseMs) s.length = 0;
    s.push({ at: now, lag: now - ts });
    while (now - s[0].at > this.windowMs) s.shift();
    let floor = Infinity;
    for (const x of s) floor = Math.min(floor, x.lag);
    const late = s.map((x) => x.lag - floor).sort((a, b) => a - b);
    const p90 = late[Math.floor(0.9 * (late.length - 1))];
    // Until there's some history, assume a typical Wi-Fi wobble.
    const wobble = s.length < 12 ? Math.max(p90, this.startBuffer) : p90;
    this.buffer = clamp(wobble + 1, this.minBuffer, this.maxBuffer);
    return ts + floor + this.buffer;
  }
}

export class Session {
  constructor({
    backend,
    onVolume = () => {},
    onStats = null,
    now = () => performance.now(),
    setInterval: setI = globalThis.setInterval,
    clearInterval: clearI = globalThis.clearInterval,
  }) {
    this.backend = backend;
    this.onVolume = onVolume;
    this.now = now;
    this.setI = setI;
    this.clearI = clearI;
    this.settings = { ...DEFAULT_SETTINGS };
    this.momentum = new Momentum();
    this.timer = null;
    this.scrollRemainder = { x: 0, y: 0 };
    this.lastClick = null;
    this.movedSinceClick = 0;
    this.held = new Set();
    this.swallowClickUntil = 0;
    this.volumeTimer = null;
    this.playout = new Playout();
    this.segments = []; // movement waiting to be played: { kind, dx, dy, start, end, done }
    this.glideTimer = null;
    this.carry = { x: 0, y: 0 }; // what rounding move ops to hundredths left over
    this.onStats = onStats;
    this.stats = { moves: 0, late: 0, since: now() };
  }

  send(op) {
    this.backend.send(op);
  }

  handle(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'touch': return this.touch();
      case 'move': return this.move(num(msg.dx), num(msg.dy), num(msg.dt, 0, 1000), stamp(msg.ts));
      case 'click': return this.click(button(msg.b));
      case 'down': return this.press(button(msg.b), true);
      case 'up': return this.press(button(msg.b), false);
      case 'scroll': return this.scroll(num(msg.dx), num(msg.dy), num(msg.dt, 0, 1000), stamp(msg.ts));
      case 'scrollEnd': return this.scrollEnd(num(msg.vx, -20, 20), num(msg.vy, -20, 20));
      case 'zoom': return this.zoom(Math.trunc(num(msg.steps, -10, 10)));
      case 'swipe': return this.swipe(msg.dir);
      case 'type': return this.type(msg);
      case 'key': return this.key(msg.k, msg.mods, msg.n);
      case 'media': return this.media(msg.k);
      case 'wheel': return this.wheel(Math.trunc(num(msg.steps, -16, 16)));
      case 'action': return this.action(msg.id);
      case 'getVolume': return this.queryVolume(0);
      case 'settings': return this.applySettings(msg);
      default: return undefined;
    }
  }

  applySettings(s) {
    if (Number.isFinite(s.pointerSpeed)) this.settings.pointerSpeed = clamp(s.pointerSpeed, 0.2, 4);
    if (Number.isFinite(s.scrollSpeed)) this.settings.scrollSpeed = clamp(s.scrollSpeed, 0.2, 4);
    if (typeof s.naturalScroll === 'boolean') this.settings.naturalScroll = s.naturalScroll;
    const config = {};
    if (typeof s.beacon === 'boolean') config.beacon = s.beacon;
    if (typeof s.ripples === 'boolean') config.ripples = s.ripples;
    if (typeof s.accent === 'string' && /^#[0-9a-f]{6}$/i.test(s.accent)) config.color = s.accent;
    if (typeof s.accent2 === 'string' && /^#[0-9a-f]{6}$/i.test(s.accent2)) config.color2 = s.accent2;
    if (Object.keys(config).length) this.send({ op: 'config', ...config });
  }

  // A finger touched the phone: stop any glide, like grabbing a scroll view.
  touch() {
    if (this.momentum.active) this.swallowClickUntil = this.now() + 350;
    this.stopMomentum();
  }

  move(dx, dy, dt, ts = null) {
    if (!dx && !dy) return;
    const speed = Math.hypot(dx, dy) / Math.max(dt || 16, 4);
    const g = pointerGain(speed, this.settings.pointerSpeed);
    const mx = dx * g;
    const my = dy * g;
    this.movedSinceClick += Math.hypot(mx, my);
    this.play('move', mx, my, dt, ts);
  }

  // Moves and scrolls play back at the pace the finger made them (each frame's
  // motion spread evenly over a frame's time), a few ms behind (see Playout),
  // not in the clumps Wi-Fi delivers them in. Without a timestamp (an older
  // phone page) they go straight out.
  play(kind, dx, dy, dt, ts) {
    if (ts === null) return this.output(kind, dx, dy);
    const t = this.now();
    const start = this.playout.when(ts, t);
    const dur = clamp(dt || 16, 1, MAX_SEGMENT_MS);
    this.segments.push({ kind, dx, dy, start, end: start + dur, done: 0 });
    if (kind === 'move') this.countStats(start < t);
    this.drain();
    if (this.segments.length && !this.glideTimer) this.glideTimer = this.setI(() => this.drain(), GLIDE_TICK_MS);
  }

  // Sends the part of each queued segment that's due by now, or all of it
  // for the kind being flushed.
  drain(flush = null) {
    const t = this.now();
    const sum = { move: { x: 0, y: 0 }, scroll: { x: 0, y: 0 } };
    this.segments = this.segments.filter((s) => {
      const f = flush === 'all' || flush === s.kind ? 1 : clamp((t - s.start) / (s.end - s.start), 0, 1);
      sum[s.kind].x += s.dx * (f - s.done);
      sum[s.kind].y += s.dy * (f - s.done);
      s.done = f;
      return f < 1;
    });
    this.output('move', sum.move.x, sum.move.y);
    this.output('scroll', sum.scroll.x, sum.scroll.y);
    if (!this.segments.length && this.glideTimer) {
      this.clearI(this.glideTimer);
      this.glideTimer = null;
    }
  }

  // Plays queued movement right now: a click must land where the pointer was headed.
  flush(kind = 'all') {
    if (this.segments.length) this.drain(kind);
  }

  output(kind, dx, dy) {
    if (kind === 'scroll') return this.emitScroll(dx, dy);
    // Carry what rounding drops, so a slow glide in tiny steps loses nothing.
    const c = this.carry;
    c.x += dx;
    c.y += dy;
    const ox = round2(c.x);
    const oy = round2(c.y);
    if (!ox && !oy) return;
    c.x -= ox;
    c.y -= oy;
    this.send({ op: 'move', dx: ox, dy: oy });
  }

  countStats(late) {
    if (!this.onStats) return;
    const st = this.stats;
    st.moves++;
    if (late) st.late++;
    const t = this.now();
    if (t - st.since < 3000) return;
    this.onStats({ moves: st.moves, late: st.late, buffer: Math.round(this.playout.buffer) });
    this.stats = { moves: 0, late: 0, since: t };
  }

  click(b) {
    this.flush();
    const t = this.now();
    if (t < this.swallowClickUntil) {
      this.swallowClickUntil = 0;
      return;
    }
    const last = this.lastClick;
    const repeat = last && last.b === b && t - last.t < DOUBLE_CLICK_MS && this.movedSinceClick < DOUBLE_CLICK_SLOP;
    const n = repeat ? Math.min(last.n + 1, 3) : 1;
    this.send({ op: 'button', b, down: true, n });
    this.send({ op: 'button', b, down: false, n });
    this.lastClick = { b, t, n };
    this.movedSinceClick = 0;
  }

  press(b, down) {
    this.flush();
    if (down === this.held.has(b)) return;
    if (down) this.held.add(b);
    else this.held.delete(b);
    this.send({ op: 'button', b, down, n: 1 });
    this.lastClick = null;
  }

  scroll(dx, dy, dt = 0, ts = null) {
    this.stopMomentum();
    this.flush('move');
    this.play('scroll', dx, dy, dt, ts);
  }

  scrollEnd(vx, vy) {
    this.flush('scroll');
    this.momentum.start(vx, vy, this.now());
    if (!this.momentum.active || this.timer) return;
    this.timer = this.setI(() => this.tick(), MOMENTUM_TICK_MS);
  }

  tick() {
    const d = this.momentum.step(this.now());
    if (d) this.emitScroll(d.dx, d.dy);
    if (!this.momentum.active) this.stopMomentum();
  }

  stopMomentum() {
    this.momentum.stop();
    if (this.timer) this.clearI(this.timer);
    this.timer = null;
  }

  // Finger deltas → whole-pixel scroll events, carrying the fraction forward.
  emitScroll(dx, dy) {
    const k = SCROLL_GAIN * this.settings.scrollSpeed * (this.settings.naturalScroll ? 1 : -1);
    const r = this.scrollRemainder;
    r.x += dx * k;
    r.y += dy * k;
    const ix = Math.trunc(r.x);
    const iy = Math.trunc(r.y);
    if (!ix && !iy) return;
    r.x -= ix;
    r.y -= iy;
    this.send({ op: 'scroll', dx: ix, dy: iy });
  }

  zoom(steps) {
    const combo = parseCombo(steps > 0 ? 'cmd+=' : 'cmd+-');
    for (let i = 0; i < Math.abs(steps); i++) this.send({ op: 'key', ...combo });
  }

  swipe(dir) {
    // Same directions as a Mac trackpad: swipe left to go to the desktop on the right.
    const sys = { up: 'missionControl', down: 'appExpose', left: 'desktopRight', right: 'desktopLeft' }[dir];
    if (sys) this.system(sys);
  }

  system(name) {
    switch (name) {
      case 'missionControl': return this.send({ op: 'missionControl' });
      case 'appExpose': return this.send({ op: 'key', ...parseCombo('ctrl+down') });
      case 'desktopLeft': return this.send({ op: 'key', ...parseCombo('ctrl+left') });
      case 'desktopRight': return this.send({ op: 'key', ...parseCombo('ctrl+right') });
      default: return undefined;
    }
  }

  // An edit of the phone's text field, already diffed into keystrokes:
  // move left `left` characters, delete `back`, type `text`, move back right.
  type({ left, back, text }) {
    const l = Math.trunc(num(left, 0, 2000));
    const b = Math.trunc(num(back, 0, 2000));
    const s = typeof text === 'string' ? text.slice(0, 4000) : '';
    if (l) this.send({ op: 'key', code: 123, mods: [], n: l });
    if (b) this.send({ op: 'key', code: 51, mods: [], n: b });
    if (s) this.send({ op: 'text', s });
    if (l) this.send({ op: 'key', code: 124, mods: [], n: l });
  }

  key(k, mods, n) {
    const key = resolveKey(k);
    if (!key) return;
    const m = cleanMods(mods);
    if (key.shift && !m.includes('shift')) m.push('shift');
    const op = { op: 'key', code: key.code, mods: m };
    if (key.char !== undefined) op.char = key.char;
    const times = Math.trunc(num(n, 1, 200)) || 1;
    if (times > 1) op.n = times;
    this.send(op);
  }

  media(k) {
    if (!['playpause', 'next', 'prev', 'volup', 'voldown', 'mute'].includes(k)) return;
    this.send({ op: 'media', k });
    if (k === 'volup' || k === 'voldown' || k === 'mute') this.queryVolume(250);
  }

  wheel(steps) {
    if (!steps) return;
    const k = steps > 0 ? 'volup' : 'voldown';
    for (let i = 0; i < Math.abs(steps); i++) this.send({ op: 'media', k });
    this.queryVolume(250);
  }

  action(id) {
    const c = findControl(id);
    if (!c) return;
    if (c.keys) this.send({ op: 'key', ...parseCombo(c.keys) });
    else if (c.media) this.media(c.media);
    else if (c.sys) this.system(c.sys);
  }

  queryVolume(delay) {
    clearTimeout(this.volumeTimer);
    this.volumeTimer = setTimeout(() => {
      Promise.resolve(this.backend.volume?.())
        .then((v) => v && this.onVolume(v))
        .catch(() => {});
    }, delay);
  }

  // The phone went away: never leave a mouse button stuck down.
  dispose() {
    this.flush();
    this.stopMomentum();
    clearTimeout(this.volumeTimer);
    for (const b of this.held) this.send({ op: 'button', b, down: false, n: 1 });
    this.held.clear();
  }
}

function stamp(ts) {
  return Number.isFinite(ts) ? ts : null;
}

function button(b) {
  return b === 'right' || b === 'middle' ? b : 'left';
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
