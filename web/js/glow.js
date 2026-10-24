// Touch glow: a soft light under each finger with a short fading tail, and a
// thin ring where you click. Animates only while something is on screen, so
// it costs nothing at rest.

const TAIL_MS = 140; // how far back the tail reaches
const FADE_MS = 260; // light fading out after the finger lifts
const IN_MS = 90; // light coming up when the finger lands
const RING_MS = 440;
const HALO = 66; // px radius of the soft light

export class TouchGlow {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.touches = new Map(); // id → { x, y, pts: [{x, y, t}], born, up }
    this.rings = [];
    this.enabled = true;
    this.setColor('#64d2ff', false);
    this.raf = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // On a light surface, additive light would vanish, so paint normally.
  setColor(hex, light) {
    const v = parseInt(hex.slice(1), 16);
    this.rgb = `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
    this.light = light;
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  point(id, x, y) {
    if (!this.enabled) return;
    const now = performance.now();
    let tc = this.touches.get(id);
    if (!tc || tc.up !== null) {
      tc = { pts: [], born: now, up: null };
      this.touches.set(id, tc);
    }
    tc.x = x;
    tc.y = y;
    tc.pts.push({ x, y, t: now });
    this.kick();
  }

  lift(id) {
    const tc = this.touches.get(id);
    if (tc && tc.up === null) tc.up = performance.now();
  }

  // A click (one ring), a right-click (two), or a hold that grabbed (a swell).
  ring(x, y, kind = 'click') {
    if (!this.enabled) return;
    this.rings.push({ x, y, kind, t: performance.now() });
    this.kick();
  }

  kick() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  rgba(a) {
    return `rgba(${this.rgb},${Math.max(0, a).toFixed(3)})`;
  }

  frame() {
    this.raf = 0;
    const now = performance.now();
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = this.light ? 'source-over' : 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const strength = this.light ? 0.75 : 1;

    for (const [id, tc] of this.touches) {
      const out = tc.up === null ? 1 : 1 - (now - tc.up) / FADE_MS;
      if (out <= 0) {
        this.touches.delete(id);
        continue;
      }
      const a = out * Math.min(1, (now - tc.born) / IN_MS) * strength;

      // Tail: one smooth stroke along the last few frames, fading towards its
      // end. (One path per pass, so segments never overlap into beads.)
      tc.pts = tc.pts.filter((p) => now - p.t < TAIL_MS);
      const pts = tc.pts;
      if (pts.length > 1) {
        const end = pts[0];
        for (const [width, alpha] of [[12, 0.16], [4, 0.55]]) {
          const fade = ctx.createLinearGradient(end.x, end.y, tc.x, tc.y);
          fade.addColorStop(0, this.rgba(0));
          fade.addColorStop(1, this.rgba(a * alpha));
          ctx.strokeStyle = fade;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(end.x, end.y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        }
      }

      // Soft light under the finger, settling in as it lands.
      const r = HALO * (0.8 + 0.2 * Math.min(1, (now - tc.born) / 220));
      const g = ctx.createRadialGradient(tc.x, tc.y, 0, tc.x, tc.y, r);
      g.addColorStop(0, this.rgba(a * 0.3));
      g.addColorStop(0.32, this.rgba(a * 0.12));
      g.addColorStop(1, this.rgba(0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(tc.x, tc.y, r, 0, Math.PI * 2);
      ctx.fill();

      // A small bright core, with a white heart on dark glass.
      ctx.fillStyle = this.rgba(a * 0.9);
      ctx.beginPath();
      ctx.arc(tc.x, tc.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (!this.light) {
        ctx.fillStyle = `rgba(255,255,255,${(a * 0.75).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(tc.x, tc.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.rings = this.rings.filter((r) => now - r.t < RING_MS);
    for (const r of this.rings) {
      const k = (now - r.t) / RING_MS;
      const ease = 1 - (1 - k) ** 3;
      ctx.lineWidth = 1.5;
      const radii = r.kind === 'right' ? [10 + ease * 30, 10 + ease * 46] : r.kind === 'grab' ? [HALO * (1.25 - 0.45 * ease)] : [8 + ease * 42];
      for (const rad of radii) {
        ctx.strokeStyle = this.rgba((1 - k) * 0.85 * strength);
        ctx.beginPath();
        ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (this.touches.size || this.rings.length) this.kick();
    else ctx.clearRect(0, 0, this.w, this.h);
  }
}
