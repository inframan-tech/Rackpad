// The iPod-style click wheel: turn it for volume, with a tick you feel on
// every notch. The centre plays/pauses; MENU mutes; ⏮ ⏭ skip tracks.

import { WheelTracker, zoneAt } from './wheel.js';

const ZONE_ACTIONS = { center: 'playpause', bottom: 'playpause', top: 'mute', left: 'prev', right: 'next' };

export class WheelView {
  constructor({ root, send, feel }) {
    this.send = send;
    this.feel = feel;
    this.el = root.querySelector('#wheel');
    this.dot = root.querySelector('#wheel-dot');
    this.center = root.querySelector('#wheel-center');
    this.readout = root.querySelector('#readout');
    this.pct = root.querySelector('#vol-pct');
    this.fill = root.querySelector('#vol-fill');
    this.tracker = new WheelTracker();
    this.touch = null;
    this.level = null;

    const el = this.el;
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (!this.touch) this.begin(e.changedTouches[0]);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = [...e.changedTouches].find((x) => x.identifier === this.touch?.id);
      if (t) this.turn(t.clientX, t.clientY);
    }, { passive: false });
    const end = (e) => {
      e.preventDefault();
      if ([...e.changedTouches].some((x) => x.identifier === this.touch?.id)) this.finish();
    };
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', end, { passive: false });

    // Mouse, for trying it on a laptop.
    let mouse = false;
    el.addEventListener('mousedown', (e) => {
      mouse = true;
      this.begin({ identifier: 'm', clientX: e.clientX, clientY: e.clientY });
    });
    window.addEventListener('mousemove', (e) => mouse && this.turn(e.clientX, e.clientY));
    window.addEventListener('mouseup', () => {
      if (!mouse) return;
      mouse = false;
      this.finish();
    });
  }

  geometry() {
    const r = this.el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, outer: r.width / 2, inner: r.width * 0.17 };
  }

  begin(t) {
    const g = this.geometry();
    const zone = zoneAt(t.clientX, t.clientY, g.cx, g.cy, g.inner, g.outer);
    if (!zone) return;
    this.touch = { id: t.identifier, zone, t0: performance.now(), g };
    this.tracker.start(Math.atan2(t.clientY - g.cy, t.clientX - g.cx));
    if (zone === 'center') this.center.classList.add('pressed');
    else this.placeDot(t.clientX, t.clientY);
  }

  turn(x, y) {
    const tc = this.touch;
    if (!tc || tc.zone === 'center') return;
    const steps = this.tracker.move(Math.atan2(y - tc.g.cy, x - tc.g.cx));
    if (this.tracker.travel > 0.15) this.el.classList.add('turning');
    this.placeDot(x, y);
    if (!steps) return;
    this.send({ t: 'wheel', steps });
    this.feel('tick');
    if (this.level !== null) this.showVolume({ level: Math.max(0, Math.min(100, this.level + steps * 6.25)), muted: false }, true);
  }

  finish() {
    const tc = this.touch;
    this.touch = null;
    this.center.classList.remove('pressed');
    this.el.classList.remove('turning');
    if (!tc) return;
    const tapped = this.tracker.travel < 0.2 && performance.now() - tc.t0 < 500;
    if (!tapped) return;
    this.send({ t: 'media', k: ZONE_ACTIONS[tc.zone] });
    this.feel('tap');
    const label = this.el.querySelector(`[data-zone="${tc.zone}"]`);
    if (label) {
      label.classList.add('flash');
      setTimeout(() => label.classList.remove('flash'), 220);
    }
  }

  // The dot rides the ring under your thumb.
  placeDot(x, y) {
    const g = this.touch?.g ?? this.geometry();
    const rect = this.el.getBoundingClientRect();
    const a = Math.atan2(y - g.cy, x - g.cx);
    const r = g.outer * 0.8;
    this.dot.style.left = `${rect.width / 2 + Math.cos(a) * r}px`;
    this.dot.style.top = `${rect.height / 2 + Math.sin(a) * r}px`;
  }

  // From the Mac (the truth), or predicted locally while turning (`guess`).
  showVolume({ level, muted }, guess = false) {
    if (!guess) this.level = level;
    this.pct.textContent = muted ? 'Muted' : String(Math.round(level));
    this.fill.style.width = `${muted ? 0 : level}%`;
    this.readout.classList.toggle('muted', !!muted);
  }
}
