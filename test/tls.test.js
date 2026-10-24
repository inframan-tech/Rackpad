import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { ensureTls, wantedNames, isPrivateIPv4, makeLeaf } from '../server/tls.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rackpad-tls-'));

// Connects the way a phone that installed Rackpad's authority would.
function trusted(port, caCert, servername) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, ca: caCert, ...(servername ? { servername } : {}) }, () => {
      resolve(socket.authorized);
      socket.end();
    });
    socket.on('error', () => resolve(false));
  });
}

test('only local names and private addresses go in the certificate', () => {
  assert.deepEqual(wantedNames('Studio', ['192.168.1.7', '100.101.102.103', '8.8.8.8', '10.0.0.4']), [
    'DNS:Studio.local', 'DNS:localhost', 'IP:127.0.0.1', 'IP:192.168.1.7', 'IP:10.0.0.4',
  ]);
  assert.equal(isPrivateIPv4('172.20.1.1'), true);
  assert.equal(isPrivateIPv4('172.32.0.1'), false);
  assert.equal(isPrivateIPv4('192.168.1'), false);
});

test("a phone that trusts Rackpad's authority accepts the Mac by name and address", async () => {
  const dir = tempDir();
  const made = ensureTls({ hostName: 'Studio', ips: ['192.168.1.7'], dir });
  assert.match(made.caName, /^Rackpad Local CA \(Studio\)$/);
  assert.equal((fs.statSync(path.join(dir, 'ca.key')).mode & 0o777).toString(8), '600', 'the authority key is private');

  const server = https.createServer({ key: made.key, cert: made.cert }, (req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal(await trusted(port, made.caCert, 'Studio.local'), true);
    assert.equal(await trusted(port, made.caCert, 'localhost'), true);
    assert.equal(await trusted(port, made.caCert), true, 'by IP address');
    assert.equal(await trusted(port, made.caCert, 'Elsewhere.local'), false, 'not for another name');
    assert.equal(await trusted(port, undefined, 'Studio.local'), false, 'not without the authority installed');
  } finally {
    server.close();
  }
});

test('the certificate is kept while nothing changes and made again for a new network', () => {
  const dir = tempDir();
  const first = ensureTls({ hostName: 'Studio', ips: ['192.168.1.7'], dir });
  assert.equal(ensureTls({ hostName: 'Studio', ips: ['192.168.1.7'], dir }).cert, first.cert);
  const moved = ensureTls({ hostName: 'Studio', ips: ['10.0.0.9'], dir });
  assert.notEqual(moved.cert, first.cert);
  assert.equal(moved.caCert, first.caCert, 'same authority: the phone needs nothing new');
  assert.ok(moved.names.includes('IP:10.0.0.9'));
  const later = ensureTls({ hostName: 'Studio', ips: ['10.0.0.9'], dir, now: new Date(Date.now() + 790 * 86400e3) });
  assert.notEqual(later.cert, moved.cert, 'renewed before it expires');
});

test("Apple's trust rules (iOS uses the same) accept the Mac and refuse any public site", { skip: process.platform !== 'darwin' && 'needs macOS' }, () => {
  const dir = tempDir();
  ensureTls({ hostName: 'Studio', ips: ['192.168.1.7'], dir });
  const verify = (cert, host) => {
    try {
      execFileSync('security', ['verify-cert', '-c', path.join(dir, cert), '-r', path.join(dir, 'ca.crt'), '-p', 'ssl', '-s', host], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(verify('server.crt', 'Studio.local'), true);
  assert.equal(verify('server.crt', '192.168.1.7'), true);
  makeLeaf(dir, 'www.apple.com', ['DNS:www.apple.com'], { out: 'forged' });
  assert.equal(verify('forged.crt', 'www.apple.com'), false, 'the authority can only vouch for local names');
});
