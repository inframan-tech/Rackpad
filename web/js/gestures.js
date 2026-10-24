// Gesture recognizers. Plain logic, no DOM: they take touch lists
// ([{ id, x, y }]) with timestamps and emit protocol messages, so they can be
// tested in Node. `emit(msg)` sends to the Mac; `feel(kind)` is haptics.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (ts) => ({
  x: ts.reduce((s, t) => s + t.x, 0) / ts.length,
  y: ts.reduce((s, t) => s + t.y, 0) / ts.length,
});

// Finger velocity over the last few frames, in px per ms. Zero if the finger
// paused before lifting, so a careful stop doesn't fling the page.
export class Velocity {
  constructor(windowMs = 80, staleMs = 45) {
    this.windowMs = windowMs;
    this.staleMs = staleMs;
    this.samples = [];
  }

  add(t, dx, dy, dt) {
    this.samples.push({ t, dx, dy, dt });
    while (this.samples.length > 1 && t - this.samples[0].t > this.windowMs) this.samples.shift();
  }

  get(t) {
    const s = this.samples;
    if (!s.length || t - s[s.length - 1].t > this.staleMs) return { vx: 0, vy: 0 };
    let dx = 0, dy = 0, dt = 0;
    for (const x of s) {
      dx += x.dx;
      dy += x.dy;
      dt += x.dt;
    }
    dt = Math.max(dt, 8);
    return { vx: dx / dt, vy: dy / dt };
  }

  reset() {
    this.samples = [];
  }
}

export const TRACKPAD = {
  tapMs: 280, // longest touch that still counts as a tap
  tapSlop: 10, // px a tap may wander
  moveSlop: 3, // px before one finger starts moving the pointer
  dragGapMs: 300, // tap, then touch again this soon and move → drag
  holdMs: 480, // press this long without moving: let go to right-click, or move to drag
  holdSlop: 8, // px a finger may drift and still count as holding still
  pinchStart: 0.12, // relative spread change that makes two fingers a pinch
  pinchStep: 1.22, // spread ratio per zoom step
  scrollStart: 6, // px two fingers travel before scrolling
  swipeDist: 55, // px three fingers travel to trigger a swipe
};

// The trackpad: one finger moves, tap clicks, two fingers scroll or pinch,
// two-finger tap right-clicks, three-finger swipes switch spaces. For one
// thumb: press and hold, then let go to right-click, or move to drag.
export class TrackpadRecognizer {
  constructor(emit, {
    feel = () => {},
    opts = {},
    // Wrapped: browsers throw "Illegal invocation" if setTimeout is called as a method.
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    this.emit = emit;
    this.feel = feel;
    this.o = { ...TRACKPAD, ...opts };
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.g = null;
    this.holdTimer = null;
    this.lastTapEnd = -Infinity;
    this.vel = new Velocity();
  }

  start(touches, t) {
    if (!this.g) {
      this.emit({ t: 'touch' });
      this.g = {
        t0: t,
        maxCount: 0,
        start: new Map(),
        last: new Map(),
        lastT: t,
        moved: 0,
        mode: null, // move | held | drag | scroll | pinch | swipe | done
        active: false, // something other than a tap already happened
        dragCandidate: t - this.lastTapEnd < this.o.dragGapMs,
      };
      if (touches.length === 1) this.holdTimer = this.setTimer(() => this.hold(), this.o.holdMs);
    }
    const g = this.g;
    for (const p of touches) {
      if (!g.start.has(p.id)) g.start.set(p.id, { x: p.x, y: p.y });
      g.last.set(p.id, { x: p.x, y: p.y });
    }
    g.maxCount = Math.max(g.maxCount, touches.length);
    this.resetBaseline(touches);
    // A second finger turns pointer movement (or a hold) into a two-finger gesture.
    if (touches.length >= 2) {
      this.cancelHold();
      if (g.mode === 'move' || g.mode === 'held') g.mode = null;
    }
  }

  // One finger stayed put long enough: it's holding, not about to tap.
  hold() {
    this.holdTimer = null;
    const g = this.g;
    if (!g || g.maxCount !== 1 || (g.mode !== null && g.mode !== 'move') || g.moved >= this.o.holdSlop) return;
    g.mode = 'held';
    g.holdAt = g.last.values().next().value;
    this.feel('grab');
  }

  cancelHold() {
    if (this.holdTimer !== null) this.clearTimer(this.holdTimer);
    this.holdTimer = null;
  }

  resetBaseline(touches) {
    const g = this.g;
    g.count = touches.length;
    g.c0 = centroid(touches);
    g.cLast = g.c0;
    g.spread0 = touches.length >= 2 ? dist(touches[0], touches[1]) : 0;
    g.pinchRef = g.spread0;
    this.vel.reset();
  }

  move(touches, t) {
    const g = this.g;
    if (!g || !touches.length) return;
    if (touches.length !== g.count) this.resetBaseline(touches);
    for (const p of touches) {
      const s = g.start.get(p.id);
      if (s) g.moved = Math.max(g.moved, dist(p, s));
    }
    if (g.moved >= this.o.holdSlop) this.cancelHold();
    const dt = Math.max(t - g.lastT, 1);
    g.lastT = t;

    if (touches.length === 1) this.moveOne(touches[0], t, dt);
    else if (touches.length === 2) this.moveTwo(touches, t, dt);
    else this.moveMany(touches);

    for (const p of touches) g.last.set(p.id, { x: p.x, y: p.y });
  }

  // Moves and scrolls carry `ts`, when the finger was there (see touch.js).
  moveOne(p, t, dt) {
    const g = this.g;
    if (g.mode === 'held') {
      // Moving on from a hold drags. Small drift while holding is ignored.
      if (dist(p, g.holdAt) < this.o.holdSlop) return;
      g.mode = 'drag';
      g.active = true;
      this.emit({ t: 'down', b: 'left' });
      this.emit({ t: 'move', dx: p.x - g.holdAt.x, dy: p.y - g.holdAt.y, dt, ts: t });
      return;
    }
    // After a two-finger gesture the leftover finger doesn't drive the pointer.
    if (g.mode && g.mode !== 'move' && g.mode !== 'drag') return;
    const last = g.last.get(p.id) ?? p;
    if (!g.mode) {
      const s = g.start.get(p.id);
      if (dist(p, s) < this.o.moveSlop) return;
      g.mode = g.dragCandidate ? 'drag' : 'move';
      g.active = true;
      if (g.mode === 'drag') {
        this.emit({ t: 'down', b: 'left' });
        this.feel('grab');
      }
      // Include the slop so no movement is lost.
      this.emit({ t: 'move', dx: p.x - s.x, dy: p.y - s.y, dt, ts: t });
      return;
    }
    this.emit({ t: 'move', dx: p.x - last.x, dy: p.y - last.y, dt, ts: t });
  }

  moveTwo(ts, t, dt) {
    const g = this.g;
    if (g.mode === 'drag' || g.mode === 'swipe' || g.mode === 'done') return;
    const c = centroid(ts);
    const spread = dist(ts[0], ts[1]);
    if (!g.mode || g.mode === 'move') {
      const ratio = spread / Math.max(g.spread0, 1);
      if (Math.abs(ratio - 1) > this.o.pinchStart && Math.abs(spread - g.spread0) > 24) {
        g.mode = 'pinch';
        g.active = true;
        g.pinchRef = g.spread0;
      } else if (dist(c, g.c0) > this.o.scrollStart) {
        g.mode = 'scroll';
        g.active = true;
        g.cLast = g.c0;
      } else {
        return;
      }
    }
    if (g.mode === 'scroll') {
      const dx = c.x - g.cLast.x;
      const dy = c.y - g.cLast.y;
      g.cLast = c;
      if (dx || dy) {
        this.emit({ t: 'scroll', dx, dy, dt, ts: t });
        this.vel.add(t, dx, dy, dt);
      }
    } else if (g.mode === 'pinch') {
      const step = this.o.pinchStep;
      while (spread / g.pinchRef > step) {
        g.pinchRef *= step;
        this.emit({ t: 'zoom', steps: 1 });
        this.feel('tick');
      }
      while (spread / g.pinchRef < 1 / step) {
        g.pinchRef /= step;
        this.emit({ t: 'zoom', steps: -1 });
        this.feel('tick');
      }
    }
  }

  moveMany(ts) {
    const g = this.g;
    if (g.mode === 'drag' || g.mode === 'done') return;
    if (g.mode !== 'swipe') {
      // Not `active` yet: a three-finger tap with a little jitter is still a tap.
      g.mode = 'swipe';
      g.swipeFrom = centroid(ts);
    }
    const c = centroid(ts);
    const dx = c.x - g.swipeFrom.x;
    const dy = c.y - g.swipeFrom.y;
    if (Math.hypot(dx, dy) < this.o.swipeDist) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    this.emit({ t: 'swipe', dir, fingers: ts.length });
    this.feel('heavy');
    g.mode = 'done';
    g.active = true;
  }

  end(touches, t) {
    const g = this.g;
    if (!g) return;
    if (g.mode === 'scroll' && touches.length < 2) {
      const { vx, vy } = this.vel.get(t);
      this.emit({ t: 'scrollEnd', vx, vy });
      g.mode = 'done';
    }
    if (touches.length > 0) {
      // The last finger of a sloppy two-finger tap shouldn't move the pointer.
      if (!g.mode && g.maxCount >= 2) g.mode = 'done';
      this.resetBaseline(touches);
      return;
    }
    this.cancelHold();
    this.g = null;
    if (g.mode === 'drag') {
      this.emit({ t: 'up', b: 'left' });
      return;
    }
    if (g.mode === 'held') {
      this.emit({ t: 'click', b: 'right' });
      this.feel('tap2');
      this.lastTapEnd = -Infinity;
      return;
    }
    const isTap = !g.active && g.moved < this.o.tapSlop && t - g.t0 < this.o.tapMs;
    if (!isTap) return;
    const b = g.maxCount >= 3 ? 'middle' : g.maxCount === 2 ? 'right' : 'left';
    this.emit({ t: 'click', b });
    this.feel(b === 'left' ? 'tap' : 'tap2');
    this.lastTapEnd = b === 'left' ? t : -Infinity;
  }

  cancel() {
    this.cancelHold();
    if (this.g?.mode === 'drag') this.emit({ t: 'up', b: 'left' });
    if (this.g?.mode === 'scroll') this.emit({ t: 'scrollEnd', vx: 0, vy: 0 });
    this.g = null;
  }
}

// The ribbed scroll strip on the edge of the pad, for scrolling with one
// thumb. Vertical only, with a light tick every few millimetres you can feel.
export class StripRecognizer {
  constructor(emit, { feel = () => {}, gain = 1.5, notch = 36 } = {}) {
    this.emit = emit;
    this.feel = feel;
    this.gain = gain;
    this.notch = notch;
    this.g = null;
    this.vel = new Velocity();
  }

  start(touches, t) {
    if (this.g || !touches.length) return;
    this.emit({ t: 'touch' });
    this.g = { id: touches[0].id, y: touches[0].y, t, travel: 0 };
    this.vel.reset();
  }

  move(touches, t) {
    const g = this.g;
    const p = g && touches.find((q) => q.id === g.id);
    if (!p) return;
    const dy = (p.y - g.y) * this.gain;
    const dt = Math.max(t - g.t, 1);
    g.y = p.y;
    g.t = t;
    if (!dy) return;
    this.emit({ t: 'scroll', dx: 0, dy, dt, ts: t });
    this.vel.add(t, 0, dy, dt);
    g.travel += Math.abs(dy);
    if (g.travel >= this.notch) {
      g.travel %= this.notch;
      this.feel('tick');
    }
  }

  end(touches, t) {
    const g = this.g;
    if (!g || touches.some((q) => q.id === g.id)) return;
    this.g = null;
    const { vy } = this.vel.get(t);
    this.emit({ t: 'scrollEnd', vx: 0, vy });
  }

  cancel() {
    if (this.g) this.emit({ t: 'scrollEnd', vx: 0, vy: 0 });
    this.g = null;
  }
}
