// Persistent settings in ~/.rackpad: the pairing token phones use to connect.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG_DIR = process.env.RACKPAD_HOME || path.join(os.homedir(), '.rackpad');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

export function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // First run, or unreadable: start fresh.
  }
  if (typeof cfg.token !== 'string' || cfg.token.length < 16) {
    cfg.token = newToken();
    cfg.firstRun = true;
    saveConfig(cfg);
  }
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const { firstRun, ...persisted } = cfg;
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
}

export function tokensEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
