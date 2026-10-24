// The link to the Mac is WebRTC, straight across the Wi-Fi: a data channel
// carries everything the two say to each other, and the Mac's screen comes
// as a video track. Setting it up takes two HTTP requests: the Mac's offer,
// then this phone's answer. iOS drops the link whenever the phone sleeps or
// the app goes to the background, so it reconnects the moment the page is
// visible again.
//
// It also keeps the link warm. Wi-Fi radios nap when traffic is sparse, and a
// napping radio holds messages: a round trip is ~75 ms with one message a
// second, ~5 ms and steady with one every 20 ms. So while you're using the
// phone it pings every 20 ms, and every 2 s once you've stopped for a while.

const WARM_MS = 20;
const WARM_FOR_MS = 30000; // after the last touch
const IDLE_MS = 2000;
const GATHER_MS = 1000; // this phone's addresses; the Mac finds it anyway if they're late
const CONNECT_MS = 8000;
const DROPPED_MS = 3000; // a link that drops gets this long to come back
const PROBE_MS = 1500; // back from the background, the link must answer this fast

export class Connection extends EventTarget {
  constructor({ token, name }) {
    super();
    this.token = token;
    this.name = name;
    this.pc = null;
    this.dc = null;
    this.stream = null; // the Mac's screen
    this.state = 'idle'; // connecting | open | closed | unauthorized | unsupported
    this.reason = null; // why the link went down, for the status line
    this.attempt = 0;
    this.retry = 0;
    this.timer = null;
    this.dropTimer = null;
    this.probeTimer = null;
    this.latency = null;
    this.pingSent = new Map();
    this.pingId = 0;
    this.lastPing = -Infinity;
    this.lastPong = -Infinity;
    this.lastUse = -Infinity;

    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (this.state === 'closed') this.connect();
      else if (this.state === 'open') this.probe();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    setInterval(() => this.keepWarm(), WARM_MS);
  }

  // The phone is being used: keep the radios awake for a while.
  use() {
    this.lastUse = performance.now();
  }

  keepWarm() {
    if (!this.open || document.visibilityState !== 'visible') return;
    const now = performance.now();
    if (now - this.lastUse < WARM_FOR_MS || now - this.lastPing >= IDLE_MS) this.ping();
  }

  query() {
    return `k=${encodeURIComponent(this.token)}&name=${encodeURIComponent(this.name)}`;
  }

  async connect() {
    clearTimeout(this.timer);
    if (this.state === 'unauthorized' || this.state === 'connecting' || this.state === 'open') return;
    if (typeof RTCPeerConnection !== 'function') {
      this.reason = 'This browser has no WebRTC';
      this.setState('unsupported');
      return;
    }
    this.setState('connecting');
    const attempt = ++this.attempt;
    const current = () => attempt === this.attempt;
    this.timer = setTimeout(() => current() && this.drop("Your Mac didn't answer"), CONNECT_MS);
    try {
      const res = await fetch(`/rtc?${this.query()}`, { method: 'POST', cache: 'no-store' });
      if (!current()) return;
      if (res.status === 401) return this.unauthorized();
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Your Mac said ${res.status}`);
      const { id, sdp } = await res.json();
      if (!current()) return;

      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      pc.ontrack = (e) => {
        // Show frames as they come: no smoothing buffer between the Mac and your finger.
        try { e.receiver.jitterBufferTarget = 0; } catch {}
        try { e.receiver.playoutDelayHint = 0; } catch {}
        this.stream = e.streams[0] ?? new MediaStream([e.track]);
        this.dispatchEvent(new CustomEvent('track', { detail: this.stream }));
      };
      pc.ondatachannel = (e) => this.useChannel(e.channel, attempt);
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        const s = pc.connectionState;
        clearTimeout(this.dropTimer);
        if (s === 'failed') this.drop("WebRTC couldn't reach your Mac. Is something on this Wi-Fi blocking UDP?");
        else if (s === 'disconnected') this.dropTimer = setTimeout(() => pc === this.pc && this.drop('The link to your Mac dropped'), DROPPED_MS);
      };
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc, GATHER_MS);
      if (!current()) return;
      const answer = await fetch(`/rtc/answer?${this.query()}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, sdp: pc.localDescription.sdp }),
      });
      if (!current()) return;
      if (answer.status === 401) return this.unauthorized();
      if (!answer.ok) throw new Error(`Your Mac said ${answer.status}`);
    } catch (err) {
      if (current()) this.drop(err.message || "Can't reach your Mac");
    }
  }

  useChannel(dc, attempt) {
    if (attempt !== this.attempt) {
      dc.close();
      return;
    }
    this.dc = dc;
    const opened = () => {
      if (dc !== this.dc) return;
      clearTimeout(this.timer);
      this.retry = 0;
      this.reason = null;
      this.setState('open');
      this.ping();
    };
    dc.onopen = opened;
    dc.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        this.lastPong = performance.now();
        const sent = this.pingSent.get(msg.id);
        this.pingSent.delete(msg.id);
        if (sent) {
          this.latency = Math.round(this.lastPong - sent);
          this.dispatchEvent(new CustomEvent('latency', { detail: this.latency }));
        }
        return;
      }
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    };
    dc.onclose = () => dc === this.dc && this.drop('The link to your Mac closed');
    if (dc.readyState === 'open') opened();
  }

  // Tear the link down and try again soon.
  drop(reason) {
    clearTimeout(this.timer);
    clearTimeout(this.dropTimer);
    clearTimeout(this.probeTimer);
    this.attempt++; // whatever was in flight is stale now
    this.reason = reason ?? null;
    const pc = this.pc;
    this.pc = null;
    this.dc = null;
    pc?.close();
    if (this.stream) {
      this.stream = null;
      this.dispatchEvent(new CustomEvent('track', { detail: null }));
    }
    if (this.state === 'unauthorized') return;
    this.setState('closed');
    const delay = Math.min(3000, 250 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.connect(), document.visibilityState === 'visible' ? delay : 5000);
  }

  unauthorized() {
    this.setState('unauthorized');
    this.drop(null); // tears down, and stays down: this phone has to pair again
  }

  // Back from the background the link may look fine but be gone: ask.
  probe() {
    const asked = performance.now();
    this.ping();
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => this.lastPong < asked && this.state === 'open' && this.drop('The link to your Mac went quiet'), PROBE_MS);
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  get open() {
    return this.dc?.readyState === 'open';
  }

  send(msg) {
    if (this.open) this.dc.send(JSON.stringify(msg));
  }

  ping() {
    if (!this.open) return;
    const id = ++this.pingId;
    this.lastPing = performance.now();
    this.pingSent.set(id, this.lastPing);
    if (this.pingSent.size > 10) this.pingSent.delete(this.pingSent.keys().next().value);
    this.send({ t: 'ping', id });
  }
}

// Resolves once the browser knows this phone's addresses, or after `ms`.
function gathered(pc, ms) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve());
    setTimeout(resolve, ms);
  });
}
