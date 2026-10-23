// Neon trails: fingers leave glowing light behind them; taps leave a ripple.
// Only animates while something is on screen, so it costs nothing at rest.

export class Trails {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trails = new Map(); // touch id → { pts: [{x, y, t}], live }
    this.ripples = [];
    this.enabled = true;
    this.cfg = { colors: ['#00e5ff', '#ff3df2'], life: 420, width: 7, glow: 18, style: 'neon' };
    this.raf = 0;
    this.hue = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setStyle(cfg) {
    this.cfg = { ...this.cfg, ...cfg };
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * this.dpr);
    this.canvas.height = Math.round(window.innerHeight * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  add(id, x, y) {
    if (!this.enabled) return;
    let tr = this.trails.get(id);
    if (!tr || !tr.live) {
      tr = { pts: [], live: true, color: this.cfg.colors[this.hue++ % this.cfg.colors.length] };
      this.trails.set(id, tr);
    }
    tr.pts.push({ x, y, t: performance.now() });
    this.kick();
  }

  lift(id) {
    const tr = this.trails.get(id);
    if (tr) tr.live = false;
  }

  ripple(x, y, secondary = false) {
    if (!this.enabled) return;
    this.ripples.push({ x, y, t: performance.now(), color: this.cfg.colors[secondary ? 1 : 0] });
    this.kick();
  }

  kick() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  frame() {
    this.raf = 0;
    const now = performance.now();
    const { ctx } = this;
    const { life, width, glow, style } = this.cfg;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.globalCompositeOperation = style === 'ink' ? 'source-over' : 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const [id, tr] of this.trails) {
      tr.pts = tr.pts.filter((p) => now - p.t < life);
      if (!tr.pts.length) {
        if (!tr.live) this.trails.delete(id);
        continue;
      }
      const pts = tr.pts;
      ctx.shadowBlur = 0;
      if (style === 'smoke') {
        this.smoke(pts, tr.color, now);
        continue;
      }
      ctx.strokeStyle = tr.color;
      // Two cheap passes instead of per-segment shadowBlur (which is slow on
      // phones): a wide faint halo, then the bright core.
      for (const pass of glow ? ['halo', 'core'] : ['core']) {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          const k = 1 - (now - b.t) / life; // 1 = fresh, 0 = gone
          ctx.globalAlpha = Math.max(0, k * (pass === 'halo' ? 0.14 : 0.9));
          ctx.lineWidth = width * (0.35 + 0.65 * k) + (pass === 'halo' ? glow * 1.1 * k : 0);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      if (style === 'neon' && tr.live) {
        // A hot white core right under the finger.
        const p = pts[pts.length - 1];
        ctx.globalAlpha = 0.9;
        ctx.shadowColor = tr.color;
        ctx.shadowBlur = glow;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, width * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.ripples = this.ripples.filter((r) => now - r.t < 520);
    for (const r of this.ripples) {
      const k = (now - r.t) / 520;
      const ease = 1 - (1 - k) ** 3;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.shadowColor = r.color;
      ctx.shadowBlur = glow;
      ctx.lineWidth = 3 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 8 + ease * 52, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    if (this.trails.size || this.ripples.length) this.kick();
    else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  // Haze: soft puffs that swell and drift upward as they fade.
  smoke(pts, color, now) {
    const { ctx } = this;
    const { life, width } = this.cfg;
    const rgb = hexToRgb(color);
    ctx.globalAlpha = 1;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1] ?? a;
      const k = 1 - (now - a.t) / life;
      const r = width * (0.7 + (1 - k) * 1.8);
      // Fill gaps between samples on fast swipes so the smoke stays continuous.
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r * 0.6)));
      for (let s = 0; s < steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps;
        const y = a.y + ((b.y - a.y) * s) / steps - (1 - k) * 30;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${rgb},${(0.2 * k) / Math.sqrt(steps)})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}
