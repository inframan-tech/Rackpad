// The Mac's screen on the phone: the video track of the WebRTC link (see
// connection.js), hardware H.264 from the Mac decoded in hardware here, each
// frame shown the moment it lands. There's no fallback. If no picture comes,
// the screen view says so and why. Touches act right where they land on the
// picture.

import { ScreenRecognizer } from './gestures.js';
import { bindSurface, onTap } from './touch.js';

const MAX_WIDTH = 1920;
const CONNECT_MS = 10000; // no picture by then: give up and say why

export class ScreenView {
  constructor({ root, send, feel }) {
    this.send = send;
    this.wrap = root.querySelector('#screen');
    this.video = root.querySelector('#screen-video');
    this.msg = root.querySelector('#screen-msg');
    this.failBox = root.querySelector('#screen-fail');
    this.failWhy = root.querySelector('#screen-fail-why');
    this.offBtn = root.querySelector('#screen-off');
    this.watching = false;
    this.dark = false;
    this.stream = null;
    this.timer = null;
    this.connectMs = CONNECT_MS;
    bindSurface(this.wrap, new ScreenRecognizer(send, { at: (p) => this.at(p), feel }));
    onTap(this.offBtn, () => {
      this.dark = !this.dark;
      this.renderOff();
      this.send({ t: 'screenOff', on: this.dark });
      feel('tick');
    });
    onTap(root.querySelector('#screen-retry'), () => this.watch(true));
    this.video.addEventListener('loadeddata', () => this.showing());
    this.video.addEventListener('resize', () => this.showing());
  }

  // The link's video track, or null while there's no link.
  attach(stream) {
    this.stream = stream;
    if (this.watching) this.play();
  }

  // Start or stop the stream; `force` asks again (after a reconnect).
  watch(on, force = false) {
    if (on === this.watching && !force) return;
    this.watching = on;
    clearTimeout(this.timer);
    this.failBox.hidden = true;
    this.video.classList.remove('playing');
    if (on) {
      this.say('Connecting to the screen…', true);
      this.timer = setTimeout(() => this.fail(this.stream ? `No picture after ${this.connectMs / 1000} seconds.` : "The WebRTC link to your Mac isn't up."), this.connectMs);
      this.play();
    } else {
      this.video.srcObject = null;
    }
    // About as many pixels as the phone has across, within reason.
    const px = Math.max(screen.width, screen.height) * Math.min(window.devicePixelRatio || 1, 3);
    this.send({ t: 'screen', on, maxWidth: Math.round(Math.min(MAX_WIDTH, Math.max(640, px))) });
    if (on && this.dark) this.send({ t: 'screenOff', on: true });
  }

  // Hand the track to the video afresh, so its first frame says the picture is up.
  play() {
    this.video.classList.remove('playing');
    this.video.srcObject = null;
    if (!this.stream) return;
    this.video.srcObject = this.stream;
    this.video.play().catch(() => {});
  }

  // The picture is up.
  showing() {
    if (!this.watching || !this.video.videoWidth) return;
    clearTimeout(this.timer);
    this.msg.hidden = true;
    this.video.classList.add('playing');
  }

  fail(reason) {
    if (!this.watching) return;
    this.watching = false;
    clearTimeout(this.timer);
    this.video.srcObject = null;
    this.video.classList.remove('playing');
    this.send({ t: 'screen', on: false });
    this.msg.hidden = true;
    this.failWhy.textContent = reason;
    this.failBox.hidden = false;
  }

  // What the Mac says about the capture itself.
  status({ on, error }) {
    if (!this.watching) return;
    if (error === 'permission') {
      clearTimeout(this.timer);
      this.say('Allow screen recording on your Mac: System Settings → Privacy & Security → Screen & System Audio Recording → switch on the app Rackpad runs in (Terminal, Ghostty…). Then come back here.');
    } else if (error) {
      clearTimeout(this.timer);
      this.say(`The screen can't be shown: ${error}`);
    } else if (!on) {
      this.say('The screen stopped.');
    } else if (this.video.classList.contains('playing')) {
      this.msg.hidden = true; // back after a restart at a new size
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
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) return null;
    const r = this.video.getBoundingClientRect();
    const scale = Math.min(r.width / w, r.height / h);
    const left = r.left + (r.width - w * scale) / 2;
    const top = r.top + (r.height - h * scale) / 2;
    const x = (p.x - left) / (w * scale);
    const y = (p.y - top) / (h * scale);
    return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
  }
}
