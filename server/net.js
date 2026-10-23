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

export function pairingUrls({ port, token, host }) {
  const { localHostName } = macNames();
  const ips = lanAddresses();
  const make = (h) => `http://${h}:${port}/?k=${encodeURIComponent(token)}`;
  const bonjour = localHostName ? `${localHostName}.local` : null;
  const primaryHost = host || bonjour || ips[0] || 'localhost';
  const fallbacks = [...new Set([bonjour, ...ips].filter((h) => h && h !== primaryHost))];
  return { primary: make(primaryHost), fallbacks: fallbacks.map(make) };
}
