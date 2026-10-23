// Smart layout: the strip above the tabs and the App tab redraw themselves
// for whatever app is in front on the Mac.

import { icon } from './icons.js';
import { onTap } from './touch.js';

const KIND_TEXT = {
  meeting: 'Meeting controls',
  slides: 'Presenter controls',
  media: 'Playback controls',
  grid: 'Shortcuts',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Smart {
  constructor({ strip, panel, tabLabel, send, feel, onThen }) {
    this.strip = strip;
    this.panel = panel;
    this.tabLabel = tabLabel;
    this.send = send;
    this.feel = feel;
    this.onThen = onThen;
    this.ctx = null;
    this.timer = { running: false, startedAt: 0, elapsed: 0 };
    setInterval(() => this.tickTimer(), 1000);
  }

  set(ctx) {
    const changed = ctx?.profile?.id !== this.ctx?.profile?.id || ctx?.app?.name !== this.ctx?.app?.name;
    this.ctx = ctx;
    if (changed) this.render();
  }

  run(control, el) {
    this.send({ t: 'action', id: control.id });
    this.feel(control.hero ? 'grab' : 'tap');
    if (el) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 180);
    }
    const short = control.id.split('.')[1];
    if (this.ctx.profile.kind === 'slides' && (short === 'next' || short === 'play') && !this.timer.running) this.toggleTimer();
    if (control.then) this.onThen(control.then);
  }

  render() {
    const { profile, app } = this.ctx;
    const byId = new Map(profile.controls.map((c) => [c.id, c]));
    this.tabLabel.textContent = profile.kind === 'grid' && profile.id === 'default' ? 'App' : profile.title;

    this.strip.innerHTML = profile.strip
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((c) => `<button class="chip${c.hero ? ' hero' : ''}" data-id="${esc(c.id)}">${icon(c.icon)}<span>${esc(c.label)}</span></button>`)
      .join('');
    this.bind(this.strip, byId);

    const title = profile.id === 'default' ? app.name || 'Mac' : profile.id === 'browser' ? app.name || profile.title : profile.title;
    const head = `<div class="sp-head">${app.icon ? `<img src="${esc(app.icon)}" alt="">` : ''}<div><div class="sp-app">${esc(title)}</div><div class="sp-kind">${KIND_TEXT[profile.kind] ?? ''}</div></div></div>`;
    const body = { meeting: () => this.meeting(profile), slides: () => this.slides(profile), media: () => this.media(profile) }[profile.kind]?.() ?? this.grid(profile.controls);
    this.panel.innerHTML = head + body;
    this.bind(this.panel, byId);
    for (const b of this.panel.querySelectorAll('[data-timer]')) {
      onTap(b, () => (b.dataset.timer === 'reset' ? this.resetTimer() : this.toggleTimer()), { scrolls: true });
    }
    this.tickTimer();
  }

  bind(root, byId) {
    for (const el of root.querySelectorAll('[data-id]')) {
      const c = byId.get(el.dataset.id);
      if (c) onTap(el, () => this.run(c, el), { scrolls: true });
    }
  }

  grid(controls) {
    return `<div class="tiles">${controls.map((c) => `<button class="tile" data-id="${esc(c.id)}">${icon(c.icon)}<span>${esc(c.label)}</span></button>`).join('')}</div>`;
  }

  hero(c, sub) {
    return `<button class="hero-btn" data-id="${esc(c.id)}">${icon(c.icon)}<span>${esc(c.label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
  }

  meeting(p) {
    const [main, ...rest] = [p.controls.find((c) => c.hero), ...p.controls.filter((c) => !c.hero)];
    return this.hero(main, 'Tap to mute or unmute') + this.grid(rest);
  }

  media(p) {
    const main = p.controls.find((c) => c.hero);
    return this.hero(main) + this.grid(p.controls.filter((c) => !c.hero));
  }

  slides(p) {
    const find = (s) => p.controls.find((c) => c.id.endsWith(`.${s}`));
    const next = find('next');
    const tile = (c) => (c ? `<button class="tile" data-id="${esc(c.id)}">${icon(c.icon)}<span>${esc(c.label)}</span></button>` : '');
    return `<div class="slides">
      <div class="timer">
        <div><div class="t-elapsed" id="t-elapsed">0:00</div><div class="t-clock" id="t-clock"></div></div>
        <div class="t-btns"><button class="pill" data-timer="toggle" id="t-toggle">Start</button><button class="pill" data-timer="reset">Reset</button></div>
      </div>
      <button class="next-btn" data-id="${esc(next.id)}">${esc(next.label)} ${icon(next.icon)}</button>
      <div class="slides-row">${tile(find('prev'))}${tile(find('play'))}${tile(find('black'))}${tile(find('end'))}</div>
    </div>`;
  }

  toggleTimer() {
    const tm = this.timer;
    if (tm.running) {
      tm.elapsed += Date.now() - tm.startedAt;
      tm.running = false;
    } else {
      tm.startedAt = Date.now();
      tm.running = true;
    }
    this.tickTimer();
  }

  resetTimer() {
    this.timer = { running: false, startedAt: 0, elapsed: 0 };
    this.tickTimer();
  }

  tickTimer() {
    const el = this.panel.querySelector('#t-elapsed');
    if (!el) return;
    const tm = this.timer;
    const ms = tm.elapsed + (tm.running ? Date.now() - tm.startedAt : 0);
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    el.textContent = h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    this.panel.querySelector('#t-clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    this.panel.querySelector('#t-toggle').textContent = tm.running ? 'Pause' : tm.elapsed ? 'Resume' : 'Start';
  }
}
