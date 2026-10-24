// Works out the addresses a phone can reach this Mac on.
//
// The QR code uses the Mac's Bonjour name (e.g. "Prakhars-MacBook.local"),
// which the iPhone resolves on any network, so the home-screen icon keeps
// working at home and at the office. The raw IP is the fallback.

import os from 'node:os';
import { execFileSync } from 'node:child_process';

function scutil(key) {
  try {
    return execFileSync('scutil', ['--get', key], { encoding: 'utf8', timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

export function macNames() {
  const host = os.hostname().replace(/\.local$/i, '');
  if (process.platform !== 'darwin') return { computerName: host, localHostName: null };
  return {
    computerName: scutil('ComputerName') ?? host,
    localHostName: scutil('LocalHostName'),
  };
}

export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  // Wi-Fi/Ethernet (en*) first, VPNs and bridges last.
  const rank = (n) => (/^en\d/.test(n) ? 0 : /^(utun|bridge|vbox|docker|veth)/.test(n) ? 2 : 1);
  out.sort((a, b) => rank(a.name) - rank(b.name));
  return out.map((a) => a.address);
}

export function pairingUrls({ port, token, host, securePort = null }) {
  const { localHostName } = macNames();
  const ips = lanAddresses();
  const make = (h) => `http://${h}:${port}/?k=${encodeURIComponent(token)}`;
  const bonjour = localHostName ? `${localHostName}.local` : null;
  const primaryHost = host || bonjour || ips[0] || 'localhost';
  const fallbacks = [...new Set([bonjour, ...ips].filter((h) => h && h !== primaryHost))];
  const secure = securePort ? `https://${primaryHost}:${securePort}/?k=${encodeURIComponent(token)}` : null;
  return { primary: make(primaryHost), fallbacks: fallbacks.map(make), secure };
}

// AirDrop, Handoff and Universal Control share the Wi-Fi radio through
// "awdl0", which hops it off your network's channel about twice a second.
// Each hop stalls Wi-Fi for ~90 ms: a hitch you can feel in the pointer.
export function awdlActive() {
  if (process.platform !== 'darwin') return false;
  try {
    return isAwdlActive(execFileSync('ifconfig', ['awdl0'], { encoding: 'utf8', timeout: 2000 }));
  } catch {
    return false;
  }
}

export function isAwdlActive(ifconfigOutput) {
  return /\bstatus: active\b/.test(ifconfigOutput);
}

export const AWDL_TIP = 'AirDrop & Handoff (awdl0) are using the Wi-Fi radio, which makes the pointer hitch about twice a second. For the smoothest pointer run: sudo ifconfig awdl0 down (it comes back on restart, or undo with: sudo ifconfig awdl0 up).';
