// WebSocket to the Mac with instant reconnects: iOS drops sockets whenever
// the phone sleeps or the app goes to the background, so we reconnect the
// moment the page is visible again.
//
// It also keeps the link warm. Wi-Fi radios nap when traffic is sparse, and a
// napping radio holds messages: a round trip is ~75 ms with one message a
// second, ~5 ms and steady with one every 20 ms. So while you're using the
// phone it pings every 20 ms, and every 2 s once you've stopped for a while.

const WARM_MS = 20;
const WARM_FOR_MS = 30000; // after the last touch
const IDLE_MS = 2000;

export class Connection extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.state = 'idle'; // connecting | open | closed | unauthorized
    this.retry = 0;
    this.timer = null;
    this.latency = null;
    this.pingSent = new Map();
    this.pingId = 0;
    this.lastPing = -Infinity;
    this.lastUse = -Infinity;

    const wake = () => {
      if (document.visibilityState === 'visible' && this.state === 'closed') this.connect();
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

  connect() {
    clearTimeout(this.timer);
    if (this.state === 'unauthorized') return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setState('open');
      this.ping();
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        const sent = this.pingSent.get(msg.id);
        this.pingSent.delete(msg.id);
        if (sent) {
          this.latency = Math.round(performance.now() - sent);
          this.dispatchEvent(new CustomEvent('latency', { detail: this.latency }));
        }
        return;
      }
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4401) {
        this.setState('unauthorized');
        return;
      }
      this.setState('closed');
      const delay = Math.min(3000, 250 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), document.visibilityState === 'visible' ? delay : 5000);
    };
    ws.onerror = () => ws.close();
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg) {
    if (this.open) this.ws.send(JSON.stringify(msg));
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
