// The screen goes to the phone as WebRTC video: a send-only H.264 track per
// watching phone, fed by the helper's hardware encoder. libdatachannel turns
// each access unit into RTP, resends what Wi-Fi drops (NACK), keeps the
// phone's clock in step (RTCP sender reports), and sends it all over
// DTLS-SRTP straight to the phone. Signaling rides the existing WebSocket.

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

let ssrcs = 0x52430000; // "RC": one SSRC per peer, never reused within a run

/**
 * One phone's video link. `signal(msg)` sends to that phone's WebSocket;
 * `keyframe()` asks the encoder for a fresh keyframe; `state(s)` reports
 * 'connected', 'failed' or 'closed'.
 */
export class ScreenPeer {
  constructor({ signal, keyframe, state = () => {}, log = () => {} }) {
    this.signal = signal;
    this.keyframe = keyframe;
    this.state = state;
    this.log = log;
    this.open = false;
    this.needKey = true;
    this.base = null; // first frame's pts, so RTP time starts at the config's random offset
    const ssrc = ++ssrcs >>> 0;

    this.pc = new ndc.PeerConnection('rackpad', { iceServers: [] });
    this.pc.onLocalDescription((sdp, type) => this.signal({ t: 'rtc', type: String(type).toLowerCase(), sdp }));
    this.pc.onLocalCandidate((candidate, mid) => this.signal({ t: 'rtc', candidate, mid }));
    this.pc.onStateChange((s) => {
      this.log(`screen link ${s}`);
      if (s === 'connected' || s === 'failed' || s === 'closed') this.state(s);
    });

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
    this.track.onOpen(() => {
      this.open = true;
      this.needKey = true;
      this.keyframe();
    });
    this.track.onClosed(() => { this.open = false; });
    // Whatever RTCP the chain leaves over lands here: the phone's "I lost
    // the picture, send a keyframe" (PLI, FIR).
    this.track.onMessage((msg) => {
      if (wantsKeyframe(msg)) {
        this.needKey = true;
        this.keyframe();
      }
    });
    this.pc.setLocalDescription(); // the offer
  }

  /** The phone's answer or one of its ICE candidates. */
  remote(msg) {
    try {
      if (msg.type === 'answer' && typeof msg.sdp === 'string') this.pc.setRemoteDescription(msg.sdp, 'answer');
      else if (typeof msg.candidate === 'string' && msg.candidate) this.pc.addRemoteCandidate(msg.candidate, String(msg.mid ?? 'screen'));
    } catch (err) {
      this.log(`screen link: ${err.message}`);
    }
  }

  /** Sends one encoded frame; until a keyframe arrives there's nothing the phone could decode. */
  send({ key, pts, au }) {
    if (!this.open) return;
    if (this.needKey && !key) return;
    this.needKey = false;
    if (this.base === null) this.base = pts;
    this.rtp.timestamp = (this.start + Math.round(((pts - this.base) * CLOCK_RATE) / 1e6)) >>> 0;
    try {
      this.track.sendMessageBinary(au);
    } catch (err) {
      this.log(`screen link: ${err.message}`);
    }
  }

  close() {
    this.open = false;
    try { this.track.close(); } catch {}
    try { this.pc.close(); } catch {}
  }
}
