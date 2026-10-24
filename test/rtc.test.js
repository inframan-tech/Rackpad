// The WebRTC link to each phone: the frames the helper writes, and the offer
// the Mac makes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFrame, readFrames } from '../server/backend.js';
import { PhoneLink, wantsKeyframe } from '../server/rtc.js';

const nalTypes = (au) => {
  const types = [];
  for (let o = 0; o + 4 <= au.length; o += 4 + au.readUInt32BE(o)) types.push(au[o + 4] & 0x1f);
  return types;
};

test('a frame from the helper: keyframe flag, capture time, then the access unit', () => {
  const buf = Buffer.concat([Buffer.from([1]), Buffer.from([0, 0, 0, 0, 0, 0x0f, 0x42, 0x40]), Buffer.from([0, 0, 0, 1, 0x65])]);
  const f = parseFrame(buf);
  assert.equal(f.key, true);
  assert.equal(f.pts, 1_000_000);
  assert.deepEqual([...f.au], [0, 0, 0, 1, 0x65]);
  assert.equal(parseFrame(Buffer.alloc(5)), null);
});

test('the dry-run clip is real H.264: it opens on SPS, PPS and an IDR picture', () => {
  const frames = readFrames(fs.readFileSync(new URL('../server/dry-run-screen.h264', import.meta.url)));
  assert.ok(frames.length >= 60);
  assert.equal(frames[0].key, true);
  assert.deepEqual(nalTypes(frames[0].au), [7, 8, 5]);
  assert.equal(frames[0].au[5], 66, 'baseline profile');
  assert.deepEqual(nalTypes(frames[1].au), [1]);
  assert.ok(frames.filter((f) => f.key).length >= 2, 'a keyframe to jump to when a phone asks');
});

test('a PLI or FIR from the phone asks for a keyframe; a receiver report does not', () => {
  const rr = Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 1]);
  const pli = Buffer.from([0x81, 206, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2]);
  const fir = Buffer.from([0x84, 206, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0]);
  assert.equal(wantsKeyframe(rr), false);
  assert.equal(wantsKeyframe(pli), true);
  assert.equal(wantsKeyframe(Buffer.concat([rr, fir])), true, 'inside a compound packet');
});

test('the Mac offers one link: a data channel and a send-only H.264 track with no playout delay', async () => {
  const link = new PhoneLink({});
  const sdp = await link.offer();
  link.close();
  assert.match(sdp, /m=video \d+ UDP\/TLS\/RTP\/SAVPF 96\r?\n/);
  assert.match(sdp, /a=sendonly/);
  assert.match(sdp, /a=rtpmap:96 H264\/90000/);
  assert.match(sdp, /packetization-mode=1/);
  assert.match(sdp, /a=extmap:\d+ http:\/\/www\.webrtc\.org\/experiments\/rtp-hdrext\/playout-delay/);
  assert.match(sdp, /m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel/);
  assert.match(sdp, /a=candidate:/, "the Mac's addresses are in the offer: no trickling needed");
});
