// The Mac's screen on the phone. The Mac sends a JPEG whenever something on
// screen changes, and the next one only after this one is showing, so the
// picture is never behind. Touches act right where they land on it.

import { ScreenRecognizer } from './gestures.js';
import { bindSurface, onTap } from './touch.js';

const MAX_WIDTH = 1600;

export class ScreenView {
  constructor({ root, send, feel }) {
    this.send = send;
    this.wrap = root.querySelector('#screen');
    this.img = root.querySelector('#screen-img');
    this.msg = root.querySelector('#screen-msg');
    this.offBtn = root.querySelector('#screen-off');
    this.watching = false;
    this.url = null;
    this.dark = false;
    bindSurface(this.wrap, new ScreenRecognizer(send, { at: (p) => this.at(p), feel }));
    onTap(this.offBtn, () => {
      this.dark = !this.dark;
      this.renderOff();
      this.send({ t: 'screenOff', on: this.dark });
      feel('tick');
    });
  }

  // Start or stop the stream; `force` asks again (after a reconnect).
  watch(on, force = false) {
    if (on === this.watching && !force) return;
    this.watching = on;
    if (on) this.say('Connecting to the screen…', true);
    // About as many pixels as the phone has across, within reason.
    const px = Math.max(screen.width, screen.height) * Math.min(window.devicePixelRatio || 1, 3);
    this.send({ t: 'screen', on, maxWidth: Math.round(Math.min(MAX_WIDTH, Math.max(640, px))) });
    if (on && this.dark) this.send({ t: 'screenOff', on: true });
  }

  frame(buf) {
    if (!this.watching) return;
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    const shown = () => {
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = url;
      this.msg.hidden = true;
      this.send({ t: 'frameAck' });
    };
    this.img.onload = shown;
    this.img.onerror = shown;
    this.img.src = url;
  }

  // What the Mac says about the stream.
  status({ on, error }) {
    if (error === 'permission') {
      this.say('Allow screen recording on your Mac: System Settings → Privacy & Security → Screen & System Audio Recording → switch on the app Rackpad runs in (Terminal, Ghostty…). Then come back here.');
    } else if (error) {
      this.say(`The screen can't be shown: ${error}`);
    } else if (!on && this.watching) {
      this.say('The screen stopped.');
    }
  }

  screenOff(on) {
    this.dark = on;
    this.renderOff();
  }

  renderOff() {
    this.offBtn.setAttribute('aria-pressed', String(this.dark));
  }

  say(text, quiet = false) {
    this.msg.textContent = text;
    this.msg.classList.toggle('quiet', quiet);
    this.msg.hidden = false;
  }

  // A touch → 0…1 across the Mac's display, or null outside the picture.
  at(p) {
    const w = this.img.naturalWidth;
    const h = this.img.naturalHeight;
    if (!w || !h) return null;
    const r = this.img.getBoundingClientRect();
    const scale = Math.min(r.width / w, r.height / h);
    const left = r.left + (r.width - w * scale) / 2;
    const top = r.top + (r.height - h * scale) / 2;
    const x = (p.x - left) / (w * scale);
    const y = (p.y - top) / (h * scale);
    return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
  }
}
