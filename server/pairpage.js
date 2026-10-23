// The page the Mac shows for pairing: a QR code to scan and a live status.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SIM_APPS = [
  ['com.apple.finder', 'Finder', ''],
  ['com.apple.Safari', 'Safari', 'Rackpad — GitHub'],
  ['com.google.Chrome', 'Google Chrome', 'Meet - abc-defg-hij'],
  ['com.google.Chrome', 'Google Chrome', 'Lo-fi beats - YouTube'],
  ['us.zoom.xos', 'zoom.us', 'Zoom Meeting'],
  ['com.apple.iWork.Keynote', 'Keynote', 'Q3 Review'],
  ['com.spotify.client', 'Spotify', ''],
  ['com.colliderli.iina', 'IINA', 'movie.mkv'],
];

export function renderPairPage({ qr, pairing, macName, version, dryRun }) {
  const sim = dryRun
    ? `<section class="card sim">
        <h2>Dry run</h2>
        <p>No input reaches this computer. Pretend a different app is in front to try the smart layouts:</p>
        <div class="sim-row">${SIM_APPS.map(([id, name, title], i) => `<button data-i="${i}">${esc(name)}${title ? ` · <span>${esc(title)}</span>` : ''}</button>`).join('')}</div>
      </section>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair Rackpad</title>
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<style>
  :root { --bg:#05060f; --card:#0d1026; --line:rgba(120,140,255,.18); --text:#eef1ff; --muted:#8a90b8; --accent:#00e5ff; --accent2:#ff3df2; --ok:#4dffa6; --warn:#ffcc4d; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background: radial-gradient(120% 80% at 50% 0%, #151a45 0%, var(--bg) 60%); color:var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; display:flex; justify-content:center; padding:48px 16px; }
  main { width:100%; max-width:880px; display:grid; grid-template-columns: 360px 1fr; gap:24px; align-items:start; }
  @media (max-width: 760px) { main { grid-template-columns: 1fr; } }
  h1 { grid-column: 1 / -1; margin:0 0 4px; font-size:32px; letter-spacing:-.02em; }
  h1 span { background: linear-gradient(90deg, var(--accent), var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .sub { grid-column: 1 / -1; margin:-12px 0 8px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:22px; padding:22px; }
  .qr { background:#fff; border-radius:18px; padding:18px; box-shadow: 0 0 60px rgba(0,229,255,.25); }
  .qr svg { display:block; width:100%; height:auto; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.12em; color:var(--muted); margin:0 0 10px; }
  ol { margin:0; padding-left:20px; } li { margin:6px 0; }
  code, .url { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; color:#cfe9ff; }
  .url { display:block; background:rgba(255,255,255,.04); border:1px solid var(--line); border-radius:10px; padding:8px 10px; margin:6px 0; }
  .status { display:grid; gap:10px; }
  .row { display:flex; gap:10px; align-items:center; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--muted); flex:none; }
  .dot.ok { background:var(--ok); box-shadow:0 0 10px var(--ok); } .dot.warn { background:var(--warn); box-shadow:0 0 10px var(--warn); }
  .muted { color:var(--muted); }
  .stack { display:grid; gap:24px; }
  .sim-row { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .sim button { background:rgba(255,255,255,.06); color:var(--text); border:1px solid var(--line); border-radius:999px; padding:8px 12px; font:inherit; font-size:13px; cursor:pointer; }
  .sim button span { color:var(--muted); }
  .sim button:hover { border-color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Pair <span>Rackpad</span></h1>
  <p class="sub">${esc(macName)} · v${esc(version)}</p>
  <div class="qr" aria-label="Pairing QR code">${qr}</div>
  <div class="stack">
    <section class="card">
      <h2>On your phone</h2>
      <ol>
        <li>Open the Camera and point it at the code.</li>
        <li>Tap the link. Rackpad opens in Safari.</li>
        <li>Tap <b>Share</b> → <b>Add to Home Screen</b>. From then on the icon connects by itself, on any network where your phone and Mac are together.</li>
      </ol>
    </section>
    <section class="card status">
      <h2>Status</h2>
      <div class="row"><span class="dot" id="d-helper"></span><span id="s-helper">Checking…</span></div>
      <div class="row"><span class="dot" id="d-phones"></span><span id="s-phones">No phones connected yet</span></div>
      <div class="row"><span class="dot ok"></span><span id="s-app" class="muted"></span></div>
    </section>
    <section class="card">
      <h2>Or type this address</h2>
      <span class="url">${esc(pairing.primary)}</span>
      ${pairing.fallbacks.length ? `<p class="muted" style="margin:10px 0 0">If that doesn't load (some office networks block <code>.local</code> names):</p>${pairing.fallbacks.map((u) => `<span class="url">${esc(u)}</span>`).join('')}` : ''}
    </section>
    ${sim}
  </div>
</main>
<script>
  const SIM = ${JSON.stringify(SIM_APPS)};
  document.querySelectorAll('.sim button').forEach((b) => b.addEventListener('click', () => {
    const [bundleId, name, title] = SIM[b.dataset.i];
    fetch('/api/simulate-app', { method: 'POST', body: JSON.stringify({ bundleId, name, title }) });
  }));
  const $ = (id) => document.getElementById(id);
  async function poll() {
    try {
      const s = await (await fetch('/api/status')).json();
      const b = s.backend;
      let helper, cls;
      if (b.kind === 'dry-run') { helper = 'Dry run: commands are logged, not performed'; cls = 'warn'; }
      else if (b.error) { helper = b.error; cls = 'warn'; }
      else if (!b.ready) { helper = 'Starting the native helper…'; cls = 'warn'; }
      else if (!b.trusted) { helper = 'Allow Accessibility access: System Settings → Privacy & Security → Accessibility, then switch on the app you started Rackpad from (e.g. Terminal).'; cls = 'warn'; }
      else { helper = 'Ready to control this Mac'; cls = 'ok'; }
      $('s-helper').textContent = helper; $('d-helper').className = 'dot ' + cls;
      $('s-phones').textContent = s.phones.length ? s.phones.length + ' connected: ' + s.phones.join(', ') : 'No phones connected yet';
      $('d-phones').className = 'dot ' + (s.phones.length ? 'ok' : '');
      $('s-app').textContent = 'In front: ' + (s.app.name || 'unknown') + ' → "' + s.profile + '" layout';
    } catch { $('s-helper').textContent = 'Rackpad is not running'; $('d-helper').className = 'dot warn'; }
  }
  poll(); setInterval(poll, 1500);
</script>
</body>
</html>`;
}
