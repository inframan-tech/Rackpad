// Local HTTPS. Phones only give a web page the microphone, a live camera and
// the motion sensors over HTTPS, so the Mac runs its own certificate
// authority: made once, restricted to local names and private addresses (it
// can never vouch for a real website), and installed on the phone once. It
// signs the Mac a certificate for its .local name and Wi-Fi addresses, which
// is made again whenever those change.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CONFIG_DIR } from './config.js';

export const TLS_DIR = path.join(CONFIG_DIR, 'tls');
const OPENSSL = fs.existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl';
const CA_DAYS = 3650;
const LEAF_DAYS = 800; // iOS accepts at most 825 for a certificate from a root you installed
const RENEW_DAYS = 30;

// What the authority may vouch for: .local names, localhost and private networks.
const PRIVATE_NETS = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['169.254.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
];
const CONSTRAINTS = ['permitted;DNS:local', 'permitted;DNS:localhost', ...PRIVATE_NETS.map(([ip, mask]) => `permitted;IP:${ip}/${mask}`)].join(', ');

const toInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
export const isPrivateIPv4 = (ip) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && PRIVATE_NETS.some(([net, mask]) => ((toInt(ip) & toInt(mask)) >>> 0) === toInt(net));

// "Prakhars-MacBook-Air" from the Mac's Bonjour name (or the hostname without one).
const cleanHost = (hostName) => String(hostName || os.hostname()).replace(/\.local$/i, '').replace(/[^A-Za-z0-9-]/g, '-');

// The names and addresses the Mac's certificate covers, e.g.
// ["DNS:Prakhars-MacBook-Air.local", "DNS:localhost", "IP:127.0.0.1", "IP:192.168.1.7"].
export function wantedNames(hostName, ips) {
  const dns = [`${cleanHost(hostName)}.local`, 'localhost'];
  const addrs = ['127.0.0.1', ...ips.filter(isPrivateIPv4)];
  return [...new Set([...dns.map((d) => `DNS:${d}`), ...addrs.map((a) => `IP:${a}`)])];
}

// Returns { key, cert, caCert, caDer, caName, caFingerprint }, creating or
// renewing whatever is missing or out of date.
export function ensureTls({ hostName, ips, dir = TLS_DIR, log = () => {}, now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (name) => path.join(dir, name);
  const safeHost = cleanHost(hostName);

  if (!fs.existsSync(file('ca.crt')) || !fs.existsSync(file('ca.key'))) {
    log("Creating Rackpad's local certificate authority (once)…");
    makeCa(dir, `Rackpad Local CA (${safeHost})`);
  }
  const caCert = fs.readFileSync(file('ca.crt'), 'utf8');
  const ca = new crypto.X509Certificate(caCert);

  const names = wantedNames(hostName, ips);
  if (!leafIsCurrent(file('server.crt'), ca, names, now)) {
    log(`Issuing this Mac's HTTPS certificate for ${names.map((n) => n.slice(n.indexOf(':') + 1)).join(', ')}`);
    makeLeaf(dir, `${safeHost}.local`, names);
  }

  return {
    key: fs.readFileSync(file('server.key'), 'utf8'),
    cert: fs.readFileSync(file('server.crt'), 'utf8'),
    caCert,
    caDer: ca.raw,
    caName: /CN=([^\n]+)/.exec(ca.subject)?.[1] ?? 'Rackpad Local CA',
    caFingerprint: ca.fingerprint256,
    names,
  };
}

function leafIsCurrent(certFile, ca, names, now) {
  let leaf;
  try {
    leaf = new crypto.X509Certificate(fs.readFileSync(certFile));
  } catch {
    return false;
  }
  const have = new Set((leaf.subjectAltName ?? '').split(', ').map((s) => s.replace(/^IP Address:/, 'IP:')));
  const sameNames = have.size === names.length && names.every((n) => have.has(n));
  const fresh = new Date(leaf.validTo).getTime() - now.getTime() > RENEW_DAYS * 86400e3;
  return sameNames && fresh && leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
}

function openssl(args, cwd) {
  execFileSync(OPENSSL, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function makeCa(dir, name) {
  fs.writeFileSync(path.join(dir, 'ca.cnf'), [
    '[req]', 'distinguished_name = dn', 'x509_extensions = v3_ca', 'prompt = no',
    '[dn]', `CN = ${name}`, 'O = Rackpad',
    '[v3_ca]',
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash',
    `nameConstraints = critical, ${CONSTRAINTS}`,
    '',
  ].join('\n'));
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key'], dir);
  fs.chmodSync(path.join(dir, 'ca.key'), 0o600);
  openssl(['req', '-x509', '-new', '-key', 'ca.key', '-out', 'ca.crt', '-days', String(CA_DAYS), '-sha256', '-config', 'ca.cnf'], dir);
}

// Signs a certificate for `names` with the authority in `dir`. Exported so a
// test can ask it for a name it must not be able to vouch for.
export function makeLeaf(dir, commonName, names, { out = 'server' } = {}) {
  fs.writeFileSync(path.join(dir, `${out}.cnf`), [
    '[req]', 'distinguished_name = dn', 'prompt = no',
    '[dn]', `CN = ${commonName}`,
    '[v3_leaf]',
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature',
    'extendedKeyUsage = serverAuth',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid',
    `subjectAltName = ${names.join(', ')}`,
    '',
  ].join('\n'));
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${out}.key`], dir);
  fs.chmodSync(path.join(dir, `${out}.key`), 0o600);
  openssl(['req', '-new', '-key', `${out}.key`, '-out', `${out}.csr`, '-config', `${out}.cnf`], dir);
  const serial = `0x${crypto.randomBytes(16).toString('hex')}`;
  openssl(['x509', '-req', '-in', `${out}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', serial,
    '-out', `${out}.crt`, '-days', String(LEAF_DAYS), '-sha256', '-extfile', `${out}.cnf`, '-extensions', 'v3_leaf'], dir);
  fs.rmSync(path.join(dir, `${out}.csr`), { force: true });
}
