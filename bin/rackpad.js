#!/usr/bin/env node
// rackpad — turn your phone into a trackpad, keyboard and remote for this Mac.

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import QRCode from 'qrcode';
import { loadConfig, saveConfig, newToken, CONFIG_DIR } from '../server/config.js';
import { macNames, pairingUrls, lanAddresses, awdlActive, AWDL_TIP } from '../server/net.js';
import { ensureTls, wantedNames } from '../server/tls.js';
import { createRackpadServer } from '../server/server.js';
import { DryRunBackend, NativeBackend, ensureHelperBuilt } from '../server/backend.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `rackpad ${version}

Usage:
  rackpad [options]        Start Rackpad and show the pairing QR code
  rackpad build-helper     (Re)compile the native macOS helper
  rackpad reset-token      Forget every paired phone (they'll need to rescan)

Options:
  --port <n>       Port to listen on (default 8421, or $RACKPAD_PORT)
  --https-port <n> Port for HTTPS (default 8422); needed for the mic and live camera
  --no-https       Serve plain HTTP only
  --host <name>    Hostname or IP to put in the QR code (default: <Mac>.local)
  --dry-run        Don't control the Mac; log what would happen instead
  --pair           Open the pairing page in your browser
  --no-open        Never open the pairing page automatically
  --verbose        Log every input command
  -h, --help       Show this help
`;

function parseArgs(argv) {
  const opts = { cmd: 'start', port: Number(process.env.RACKPAD_PORT) || 8421, httpsPort: 8422, https: true, host: null, dryRun: false, pair: false, open: true, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--port') opts.port = Number(value());
    else if (a === '--https-port') opts.httpsPort = Number(value());
    else if (a === '--no-https') opts.https = false;
    else if (a === '--host') opts.host = value();
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--pair') opts.pair = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '-h' || a === '--help') opts.cmd = 'help';
    else if (!a.startsWith('-') && ['start', 'build-helper', 'reset-token', 'help'].includes(a)) opts.cmd = a;
    else fail(`Unknown option: ${a}\n\n${HELP}`);
  }
  for (const [flag, port] of [['--port', opts.port], ['--https-port', opts.httpsPort]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${flag} must be a number between 1 and 65535`);
  }
  return opts;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const log = (msg) => console.log(`${new Date().toLocaleTimeString()}  ${msg}`);

async function start(opts) {
  const cfg = loadConfig();
  const onMac = process.platform === 'darwin';
  if (!onMac && !opts.dryRun) {
    console.log('Not running on macOS, so starting in --dry-run mode.\n');
    opts.dryRun = true;
  }

  const backend = opts.dryRun ? new DryRunBackend({ log, verbose: opts.verbose }) : new NativeBackend({ log, verbose: opts.verbose });
  backend.on('status', (s) => {
    if (s.error) log(`⚠️  ${s.error}`);
    else if (s.ready && !s.trusted) log('⚠️  Waiting for Accessibility permission: System Settings → Privacy & Security → Accessibility');
    else if (s.ready && s.trusted) log('✅ Ready to control this Mac');
  });

  const { computerName, localHostName } = macNames();
  // HTTPS with Rackpad's own local certificate (see server/tls.js).
  let tls = null;
  if (opts.https) {
    try {
      tls = ensureTls({ hostName: localHostName, ips: lanAddresses(), log });
    } catch (err) {
      log(`⚠️  HTTPS is off: could not make the certificate (${err.message.split('\n')[0]})`);
    }
  }
  const pairing = pairingUrls({ port: opts.port, token: cfg.token, host: opts.host, securePort: tls ? opts.httpsPort : null });
  const app = createRackpadServer({ backend, token: cfg.token, macName: computerName, version, pairing, tls, log });

  const listen = async (start, port, flag) => {
    try {
      await start(port);
    } catch (err) {
      if (err.code === 'EADDRINUSE') fail(`Port ${port} is busy. Is Rackpad already running? Try ${flag} <another>.`);
      throw err;
    }
  };
  await listen((p) => app.listen(p), opts.port, '--port');
  if (tls) {
    await listen((p) => app.listenSecure(p), opts.httpsPort, '--https-port');
    // Join a new network and the certificate is made again for the new address.
    setInterval(() => {
      const names = wantedNames(localHostName, lanAddresses());
      if (names.join() === tls.names.join()) return;
      try {
        tls = ensureTls({ hostName: localHostName, ips: lanAddresses(), log });
        app.setTls(tls);
      } catch (err) {
        log(`⚠️  Could not renew the HTTPS certificate: ${err.message.split('\n')[0]}`);
      }
    }, 30000).unref();
  }
  backend.start();

  const qr = await QRCode.toString(pairing.primary, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
  console.log(`
  Rackpad ${version}${opts.dryRun ? '  (dry run: nothing on this computer will be controlled)' : ''}
  Your phone is now a trackpad for “${computerName}”.

${qr.replace(/^/gm, '  ')}
  Scan with your phone's camera, or open:
    ${pairing.primary}
${pairing.fallbacks.length ? `  If that doesn't load:\n${pairing.fallbacks.map((u) => `    ${u}`).join('\n')}\n` : ''}
${pairing.secure ? `  Secure (once the phone trusts Rackpad's certificate):\n    ${pairing.secure}\n\n` : ''}  Pairing page: http://localhost:${opts.port}/pair
`);
  if (onMac && !opts.dryRun && awdlActive()) log(`⚠️  ${AWDL_TIP}`);

  if (onMac && opts.open && (opts.pair || cfg.firstRun)) {
    execFile('open', [`http://localhost:${opts.port}/pair`], () => {});
  }

  const shutdown = () => {
    backend.stop();
    app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const opts = parseArgs(process.argv.slice(2));
switch (opts.cmd) {
  case 'help':
    console.log(HELP);
    break;
  case 'build-helper':
    if (process.platform !== 'darwin') fail('The native helper can only be built on macOS.');
    try {
      console.log(`Built ${ensureHelperBuilt({ log: console.log, force: true })}`);
    } catch (err) {
      fail(err.message);
    }
    break;
  case 'reset-token': {
    const cfg = loadConfig();
    cfg.token = newToken();
    saveConfig(cfg);
    console.log(`New pairing code saved in ${CONFIG_DIR}. Restart Rackpad and rescan the QR code on each phone.`);
    break;
  }
  default:
    await start(opts);
}
