// Each phone talks to the Mac over one WebRTC link, straight across the
// Wi-Fi with no server in between:
//
// - a data channel carries everything the phone and Mac say to each other
//   (touches, keys, pings, the app in front), over UDP;
// - a send-only H.264 video track carries the screen, fed by the helper's
//   hardware encoder. libdatachannel turns each access unit into RTP, resends
//   what Wi-Fi drops (NACK), keeps the phone's clock in step (RTCP sender
//   reports), and encrypts it all (DTLS-SRTP).
//
// Setting the link up takes two plain HTTP requests (see server.js): the Mac
// makes the offer, the phone answers.

import ndc from 'node-datachannel';

const PAYLOAD_TYPE = 96;
const CLOCK_RATE = 90000;
// Constrained baseline: every phone decodes it in hardware. The level may run
// higher than 3.1 for a big screen, which level-asymmetry-allowed permits.
const H264_FMTP = 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1';
// Asks the phone to show each frame as soon as it's decoded, with no
// smoothing buffer: a pointer you're steering must not trail behind.
const PLAYOUT_DELAY_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';
const PLAYOUT_DELAY_ID = 6;
const MAX_FRAGMENT = 1200; // bytes of H.264 per RTP packet, safely under Wi-Fi's MTU
const NACK_HISTORY = 2048; // packets kept for resending: a few keyframes' worth
const GATHER_MS = 1000; // the Mac's own addresses are known at once; don't wait on slow ones
const DROPPED_MS = 6000; // a link that drops gets this long to come back
export const MAX_MESSAGE = 64 * 1024;

/** Stops libdatachannel's threads, which otherwise keep Node running: after the last link closes. */
export function shutdownLinks() {
  ndc.cleanup();
}

/** True when an RTCP packet asks for a fresh keyframe (PLI or FIR). */
export function wantsKeyframe(buf) {
  let o = 0;
  while (o + 4 <= buf.length) {
    const fmt = buf[o] & 0x1f, pt = buf[o + 1];
    if (pt === 206 && (fmt === 1 || fmt === 4)) return true;
    o += (buf.readUInt16BE(o + 2) + 1) * 4;
  }
  return false;
}

// A throw inside a libdatachannel callback would abort the whole process,
// so every callback reports its errors instead.
const guard = (log, fn) => (...args) => {
  try {
    fn(...args);
  } catch (err) {
    log(`link: ${err.stack ?? err}`);
  }
};

let ssrcs = 0x52430000; // "RC": one SSRC per link, never reused within a run

/**
 * One phone's link. `onOpen()` fires when the phone can talk, `onMessage(msg)`
 * for each JSON message, `onClose()` once when it's gone for good;
 * `keyframe()` asks the encoder for a fresh keyframe.
 */
export class PhoneLink {
  constructor({ onOpen = () => {}, onMessage = () => {}, onClose = () => {}, keyframe = () => {}, log = () => {}, onError = console.error }) {
    const safe = (fn) => guard(onError, fn);
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.keyframe = keyframe;
    this.log = log;
    this.closed = false;
    this.watching = false;
    this.videoOpen = false;
    this.needKey = true;
    this.base = null; // first frame's pts, so RTP time starts at the config's random offset
    this.dropTimer = null;
    const ssrc = ++ssrcs >>> 0;

    this.pc = new ndc.PeerConnection('rackpad', { iceServers: [], disableAutoNegotiation: true, maxMessageSize: MAX_MESSAGE });
    this.gathered = new Promise((resolve) => {
      this.pc.onGatheringStateChange(safe((s) => s === 'complete' && resolve()));
      setTimeout(resolve, GATHER_MS);
    });
    this.pc.onStateChange(safe((s) => {
      this.log(`link ${s}`);
      clearTimeout(this.dropTimer);
      if (s === 'failed' || s === 'closed') this.close();
      else if (s === 'disconnected') this.dropTimer = setTimeout(() => this.close(), DROPPED_MS);
    }));

    // The screen.
    const video = new ndc.Video('screen', 'SendOnly');
    video.addH264Codec(PAYLOAD_TYPE, H264_FMTP);
    video.addSSRC(ssrc, 'rackpad', 'rackpad', 'screen');
    video.parseSdpLine(`a=extmap:${PLAYOUT_DELAY_ID} ${PLAYOUT_DELAY_URI}`);
    this.track = this.pc.addTrack(video);
    this.rtp = new ndc.RtpPacketizationConfig(ssrc, 'rackpad', PAYLOAD_TYPE, CLOCK_RATE);
    this.rtp.playoutDelayId = PLAYOUT_DELAY_ID;
    this.rtp.playoutDelayMin = 0;
    this.rtp.playoutDelayMax = 0;
    this.start = this.rtp.timestamp;
    const packetizer = new ndc.H264RtpPacketizer('Length', this.rtp, MAX_FRAGMENT);
    packetizer.addToChain(new ndc.RtcpSrReporter(this.rtp));
    packetizer.addToChain(new ndc.RtcpNackResponder(NACK_HISTORY));
    this.track.setMediaHandler(packetizer);
    this.track.onOpen(safe(() => {
      this.videoOpen = true;
      if (this.watching) this.freshPicture();
    }));
    // Whatever RTCP the chain leaves over lands here: the phone's "I lost
    // the picture, send a keyframe" (PLI, FIR).
    this.track.onMessage(safe((msg) => {
      if (this.watching && wantsKeyframe(msg)) this.freshPicture();
    }));

    // Everything else.
    this.dc = this.pc.createDataChannel('rackpad');
    this.dc.onOpen(safe(() => this.onOpen()));
    this.dc.onClosed(safe(() => this.close()));
    this.dc.onMessage(safe((data) => {
      if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') onMessage(msg);
    }));

    this.pc.setLocalDescription(); // the offer
  }

  /** The offer, with the Mac's addresses in it. */
  async offer() {
    await this.gathered;
    return this.pc.localDescription()?.sdp ?? null;
  }

  /** The phone's answer, with its addresses in it. */
  answer(sdp) {
    this.pc.setRemoteDescription(sdp, 'answer');
  }

  get open() {
    return !this.closed && this.dc.isOpen();
  }

  send(msg) {
    if (!this.open) return;
    try {
      this.dc.sendMessage(JSON.stringify(msg));
    } catch (err) {
      this.log(`link: ${err.message}`);
    }
  }

  /** Start or stop sending the screen. It starts on a keyframe. */
  watch(on) {
    this.watching = on;
    if (on && this.videoOpen) this.freshPicture();
  }

  freshPicture() {
    this.needKey = true;
    this.keyframe();
  }

  /** One encoded frame; until a keyframe arrives there's nothing the phone could decode. */
  frame({ key, pts, au }) {
    if (!this.watching || !this.videoOpen || this.closed) return;
    if (this.needKey && !key) return;
    this.needKey = false;
    if (this.base === null) this.base = pts;
    this.rtp.timestamp = (this.start + Math.round(((pts - this.base) * CLOCK_RATE) / 1e6)) >>> 0;
    try {
      this.track.sendMessageBinary(au);
    } catch (err) {
      this.log(`link: ${err.message}`);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.dropTimer);
    for (const c of [this.dc, this.track, this.pc]) {
      try { c.close(); } catch {}
    }
    this.onClose();
  }
}
