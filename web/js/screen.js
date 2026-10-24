// The Mac's screen on the phone, over WebRTC: hardware H.264 from the Mac,
// decoded in hardware here, each frame shown the moment it lands. There's no
// fallback. If WebRTC can't connect, the screen view says so and why.
// Touches act right where they land on the picture.

import { ScreenRecognizer } from './gestures.js';
import { bindSurface, onTap } from './touch.js';

const MAX_WIDTH = 1920;
const CONNECT_MS = 10000; // no picture by then: give up and say why
const DROPPED_MS = 5000; // a link that drops gets this long to come back

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
    this.pc = null;
    this.signals = Promise.resolve(); // signaling, strictly in order
    this.timer = null;
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

  // Start or stop the stream; `force` asks again (after a reconnect).
  watch(on, force = false) {
    if (on === this.watching && !force) return;
    this.watching = on;
    this.hangUp();
    this.failBox.hidden = true;
    if (on) {
      if (typeof RTCPeerConnection !== 'function') {
        this.fail('This browser has no WebRTC.');
        return;
      }
      this.say('Connecting to the screen…', true);
      this.wait(CONNECT_MS, 'No picture after 10 seconds.');
    }
    // About as many pixels as the phone has across, within reason.
    const px = Math.max(screen.width, screen.height) * Math.min(window.devicePixelRatio || 1, 3);
    this.send({ t: 'screen', on, maxWidth: Math.round(Math.min(MAX_WIDTH, Math.max(640, px))) });
    if (on && this.dark) this.send({ t: 'screenOff', on: true });
  }

  // WebRTC signaling from the Mac: its offer, its ICE candidates, or an error.
  rtc(msg) {
    if (!this.watching) return;
    if (msg.error) {
      this.fail(msg.error);
      return;
    }
    this.signals = this.signals.then(() => this.signal(msg)).catch((err) => this.fail(`WebRTC: ${err.message}`));
  }

  async signal(msg) {
    if (!this.watching) return;
    if (msg.type === 'offer') {
      this.closePeer();
      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      pc.ontrack = (e) => {
        // Show frames as they come: no smoothing buffer between the Mac and your finger.
        try { e.receiver.jitterBufferTarget = 0; } catch {}
        try { e.receiver.playoutDelayHint = 0; } catch {}
        this.video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        this.video.play().catch(() => {});
      };
      pc.onicecandidate = (e) => {
        if (e.candidate?.candidate) this.send({ t: 'rtc', candidate: e.candidate.candidate, mid: e.candidate.sdpMid });
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        const s = pc.connectionState;
        if (s === 'failed') this.fail("WebRTC couldn't reach your Mac. Is something on this Wi-Fi blocking UDP?");
        else if (s === 'disconnected') this.wait(DROPPED_MS, 'The video link to your Mac dropped.');
        else if (s === 'connected' && this.video.videoWidth) this.showing();
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      this.send({ t: 'rtc', type: 'answer', sdp: pc.localDescription.sdp });
    } else if (msg.candidate && this.pc) {
      await this.pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid ?? '0' });
    }
  }

  // The picture is up.
  showing() {
    if (!this.watching || !this.video.videoWidth) return;
    clearTimeout(this.timer);
    this.msg.hidden = true;
    this.video.classList.add('playing');
  }

  // Unless the picture shows within `ms`, fail with `reason`.
  wait(ms, reason) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(reason), ms);
  }

  fail(reason) {
    if (!this.watching) return;
    this.watching = false;
    this.hangUp();
    this.send({ t: 'screen', on: false });
    this.msg.hidden = true;
    this.failWhy.textContent = reason;
    this.failBox.hidden = false;
  }

  hangUp() {
    clearTimeout(this.timer);
    this.closePeer();
  }

  closePeer() {
    this.pc?.close();
    this.pc = null;
    this.video.classList.remove('playing');
    this.video.srcObject = null;
  }

  // What the Mac says about the capture itself.
  status({ on, error }) {
    if (!this.watching) return;
    if (error === 'permission') {
      this.hangUp();
      this.say('Allow screen recording on your Mac: System Settings → Privacy & Security → Screen & System Audio Recording → switch on the app Rackpad runs in (Terminal, Ghostty…). Then come back here.');
    } else if (error) {
      this.hangUp();
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
