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
  pinchStart: 0.12, // relative spread change that makes two fingers a pinch
  pinchStep: 1.22, // spread ratio per zoom step
  scrollStart: 6, // px two fingers travel before scrolling
  swipeDist: 55, // px three fingers travel to trigger a swipe
};

// The main trackpad: one finger moves, tap clicks, two fingers scroll or
// pinch, two-finger tap right-clicks, three-finger swipes switch spaces.
export class TrackpadRecognizer {
  constructor(emit, { feel = () => {}, opts = {} } = {}) {
    this.emit = emit;
    this.feel = feel;
    this.o = { ...TRACKPAD, ...opts };
    this.g = null;
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
        mode: null, // move | drag | scroll | pinch | swipe | done
        active: false, // something other than a tap already happened
        dragCandidate: t - this.lastTapEnd < this.o.dragGapMs,
      };
    }
    const g = this.g;
    for (const p of touches) {
      if (!g.start.has(p.id)) g.start.set(p.id, { x: p.x, y: p.y });
      g.last.set(p.id, { x: p.x, y: p.y });
    }
    g.maxCount = Math.max(g.maxCount, touches.length);
    this.resetBaseline(touches);
    // A second finger turns pointer movement into a two-finger gesture.
    if (touches.length >= 2 && g.mode === 'move') g.mode = null;
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
    const dt = Math.max(t - g.lastT, 1);
    g.lastT = t;

    if (touches.length === 1) this.moveOne(touches[0], dt);
    else if (touches.length === 2) this.moveTwo(touches, t, dt);
    else this.moveMany(touches);

    for (const p of touches) g.last.set(p.id, { x: p.x, y: p.y });
  }

  moveOne(p, dt) {
    const g = this.g;
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
      this.emit({ t: 'move', dx: p.x - s.x, dy: p.y - s.y, dt });
      return;
    }
    this.emit({ t: 'move', dx: p.x - last.x, dy: p.y - last.y, dt });
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
        this.emit({ t: 'scroll', dx, dy });
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
    this.g = null;
    if (g.mode === 'drag') {
      this.emit({ t: 'up', b: 'left' });
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
    if (this.g?.mode === 'drag') this.emit({ t: 'up', b: 'left' });
    if (this.g?.mode === 'scroll') this.emit({ t: 'scrollEnd', vx: 0, vy: 0 });
    this.g = null;
  }
}

export const COUCH = {
  holdMs: 430, // press this long to "grab"
  slop: 10,
  tapMs: 300,
};

// One-thumb mode. Tap clicks; press and hold, then move, drags; press and
// hold, then let go, right-clicks. Extra fingers are ignored.
export class CouchRecognizer {
  constructor(emit, {
    feel = () => {},
    opts = {},
    // Wrapped: browsers throw "Illegal invocation" if setTimeout is called as a method.
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    this.emit = emit;
    this.feel = feel;
    this.o = { ...COUCH, ...opts };
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.g = null;
    this.timer = null;
  }

  start(touches, t) {
    if (this.g || !touches.length) return;
    const p = touches[0];
    this.emit({ t: 'touch' });
    this.g = { id: p.id, x0: p.x, y0: p.y, x: p.x, y: p.y, t0: t, lastT: t, mode: null };
    this.timer = this.setTimer(() => this.hold(), this.o.holdMs);
  }

  hold() {
    this.timer = null;
    if (this.g && this.g.mode === null) {
      this.g.mode = 'held';
      this.feel('grab');
    }
  }

  move(touches, t) {
    const g = this.g;
    const p = g && touches.find((q) => q.id === g.id);
    if (!p) return;
    const dt = Math.max(t - g.lastT, 1);
    g.lastT = t;
    const far = Math.hypot(p.x - g.x0, p.y - g.y0) > this.o.slop;
    if (g.mode === null && far) {
      this.clearTimer(this.timer);
      this.timer = null;
      g.mode = 'move';
      this.emit({ t: 'move', dx: p.x - g.x0, dy: p.y - g.y0, dt });
    } else if (g.mode === 'held' && far) {
      g.mode = 'drag';
      this.emit({ t: 'down', b: 'left' });
      this.emit({ t: 'move', dx: p.x - g.x, dy: p.y - g.y, dt });
    } else if (g.mode === 'move' || g.mode === 'drag') {
      this.emit({ t: 'move', dx: p.x - g.x, dy: p.y - g.y, dt });
    }
    g.x = p.x;
    g.y = p.y;
  }

  end(touches) {
    const g = this.g;
    if (!g || touches.some((q) => q.id === g.id)) return;
    this.clearTimer(this.timer);
    this.timer = null;
    this.g = null;
    if (g.mode === null) {
      this.emit({ t: 'click', b: 'left' });
      this.feel('tap');
    } else if (g.mode === 'held') {
      this.emit({ t: 'click', b: 'right' });
      this.feel('tap2');
    } else if (g.mode === 'drag') {
      this.emit({ t: 'up', b: 'left' });
    }
  }

  cancel() {
    this.clearTimer(this.timer);
    if (this.g?.mode === 'drag') this.emit({ t: 'up', b: 'left' });
    this.g = null;
  }
}

// The ribbed scroll strip on the edge of couch mode. Vertical only, with a
// light tick every few millimetres so you can feel it move.
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
    this.emit({ t: 'scroll', dx: 0, dy });
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
