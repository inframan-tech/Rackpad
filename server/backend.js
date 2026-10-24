// Backends execute input commands. On a Mac that's the native Swift helper;
// everywhere else (and with --dry-run) a stand-in that just records them.

import { EventEmitter } from 'node:events';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HELPER_SOURCE = path.join(HERE, '..', 'helper', 'RackpadHelper.swift');
const HELPER_BIN = path.join(CONFIG_DIR, 'bin', 'rackpad-helper');

const DEFAULT_APP = { bundleId: 'com.apple.finder', name: 'Finder' };
const DRY_RUN_SCREEN = path.join(HERE, 'dry-run-screen.jpg');

// Screen frames from the helper (file descriptor 3): a 4-byte big-endian
// length, then a JPEG. Chunks from the pipe arrive split anywhere.
export class FrameReader {
  constructor(onFrame, { maxFrame = 16 * 1024 * 1024 } = {}) {
    this.onFrame = onFrame;
    this.maxFrame = maxFrame;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxFrame) {
        this.buf = Buffer.alloc(0); // not a frame boundary any more: start over
        return;
      }
      if (this.buf.length < 4 + len) return;
      this.onFrame(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
  }
}

// For --verbose logs: every command, but never what was typed.
export function describeOp(op) {
  return JSON.stringify(op.op === 'text' ? { ...op, s: `<${[...op.s].length} chars>` } : op);
}

class Backend extends EventEmitter {
  constructor() {
    super();
    this.app = { ...DEFAULT_APP };
    this.status = { kind: 'none', ready: false, trusted: false, error: null };
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  setApp(app) {
    this.app = { ...app };
    this.emit('app', this.app);
  }
}

export class DryRunBackend extends Backend {
  constructor({ log = () => {}, verbose = false } = {}) {
    super();
    this.log = log;
    this.verbose = verbose;
    this.ops = [];
    this.level = 50;
    this.muted = false;
    this.status = { kind: 'dry-run', ready: true, trusted: true, error: null };
  }


  start() {}

  send(op) {
    this.ops.push(op);
    if (this.ops.length > 5000) this.ops.splice(0, 1000);
    if (op.op === 'media') {
      if (op.k === 'volup') this.level = Math.min(100, this.level + 6.25);
      if (op.k === 'voldown') this.level = Math.max(0, this.level - 6.25);
      if (op.k === 'mute') this.muted = !this.muted;
    }
    if (op.op === 'screen') this.fakeScreen(!!op.on);
    if (op.op === 'screenOff') this.emit('screenOff', !!op.on);
    if (this.verbose) this.log(`→ ${describeOp(op)}`);
  }

  // A stand-in picture a few times a second, so the screen view can be tried anywhere.
  fakeScreen(on) {
    clearInterval(this.screenTimer);
    this.screenTimer = null;
    this.emit('screen', { on, error: null, width: 640, height: 400 });
    if (!on) return;
    this.screenFrame ??= fs.readFileSync(DRY_RUN_SCREEN);
    this.emit('frame', this.screenFrame);
    this.screenTimer = setInterval(() => this.emit('frame', this.screenFrame), 250);
    this.screenTimer.unref();
  }

  async volume() {
    return { level: Math.round(this.level), muted: this.muted };
  }

  stop() {
    this.fakeScreen(false);
  }
}

export class NativeBackend extends Backend {
  constructor({ log = () => {}, verbose = false, binPath = HELPER_BIN } = {}) {
    super();
    this.log = log;
    this.verbose = verbose;
    this.binPath = binPath;
    this.proc = null;
    this.restarts = 0;
    this.stopped = false;
    this.status = { kind: 'native', ready: false, trusted: false, error: null };
  }

  start() {
    this.stopped = false;
    let bin;
    try {
      bin = ensureHelperBuilt({ log: this.log, out: this.binPath });
    } catch (err) {
      this.setStatus({ ready: false, error: err.message });
      return;
    }
    // stdin: commands; stdout: events; fd 3: screen frames.
    const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'] });
    this.proc = proc;
    proc.stdin.on('error', () => {});
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    const frames = new FrameReader((jpeg) => this.emit('frame', jpeg));
    proc.stdio[3].on('data', (chunk) => frames.push(chunk));
    proc.stdio[3].on('error', () => {});
    proc.on('error', (err) => this.setStatus({ ready: false, error: err.message }));
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.setStatus({ ready: false });
      if (this.stopped) return;
      const delay = Math.min(10000, 500 * 2 ** this.restarts++);
      this.log(`Native helper exited (${signal ?? code}); restarting in ${delay}ms`);
      setTimeout(() => !this.stopped && this.start(), delay);
    });
  }

  onLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    switch (ev.ev) {
      case 'ready':
        this.restarts = 0;
        this.setStatus({ ready: true, trusted: !!ev.trusted, error: null });
        break;
      case 'trusted':
        this.setStatus({ trusted: !!ev.value });
        break;
      case 'app':
        this.setApp({ bundleId: ev.bundleId ?? '', name: ev.name ?? '', title: ev.title, icon: ev.icon });
        break;
      case 'screen':
        this.emit('screen', { on: !!ev.on, error: ev.error ?? null, width: ev.width, height: ev.height });
        break;
      case 'screenOff':
        this.emit('screenOff', !!ev.on);
        break;
      case 'log':
        this.log(`helper: ${ev.msg}`);
        break;
      default:
        break;
    }
  }

  send(op) {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify(op)}\n`);
    if (this.verbose) this.log(`→ ${describeOp(op)}`);
  }

  volume() {
    return new Promise((resolve) => {
      execFile('osascript', ['-e', 'get volume settings'], { timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseVolumeSettings(stdout));
      });
    });
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }
}

// "output volume:44, input volume:75, alert volume:100, output muted:false"
export function parseVolumeSettings(text) {
  const level = /output volume:(\d+|missing value)/.exec(text);
  const muted = /output muted:(true|false|missing value)/.exec(text);
  if (!level || level[1] === 'missing value') return null;
  return { level: Number(level[1]), muted: muted?.[1] === 'true' };
}

// Compiles the Swift helper on first run (and whenever its source changes).
export function ensureHelperBuilt({ log = () => {}, out = HELPER_BIN, force = false } = {}) {
  const source = fs.readFileSync(HELPER_SOURCE);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const stamp = `${out}.hash`;
  if (!force && fs.existsSync(out) && readOr(stamp) === hash) return out;

  log('Building the native helper (first run only, takes ~30s)…');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    execFileSync('swiftc', ['-O', '-swift-version', '5', '-o', out, HELPER_SOURCE], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('swiftc not found. Install the Xcode Command Line Tools with: xcode-select --install');
    }
    throw new Error(`Building the native helper failed (${err.message})`);
  }
  fs.writeFileSync(stamp, hash);
  return out;
}

function readOr(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return fallback;
  }
}
