// Rackpad phone app: wiring between the views, the settings and the Mac.

import { Connection } from './connection.js';
import { TrackpadRecognizer, CouchRecognizer, StripRecognizer } from './gestures.js';
import { bindSurface, onTap } from './touch.js';
import { Trails } from './trails.js';
import { THEMES, themeById } from './themes.js';
import { hydrateIcons } from './icons.js';
import { feel, setHapticsEnabled } from './haptics.js';
import { Keys } from './keys.js';
import { WheelView } from './wheelview.js';
import { Smart } from './smart.js';

const $ = (sel) => document.querySelector(sel);
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(`rackpad.${k}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`rackpad.${k}`, JSON.stringify(v));
    } catch {
      // Private mode: settings just won't stick.
    }
  },
};

const DEFAULTS = {
  theme: 'neon',
  pointerSpeed: 1,
  scrollSpeed: 1,
  naturalScroll: true,
  trails: true,
  ripples: true,
  beacon: true,
  haptics: true,
  stripLeft: false,
  liveTyping: true,
  view: 'pad',
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

hydrateIcons();
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// ── Pairing token ───────────────────────────────────────────────────────
// The token rides in the URL so "Add to Home Screen" keeps it: home-screen
// web apps on iOS don't share storage with Safari.
const params = new URLSearchParams(location.search);
const token = params.get('k') || store.get('token', null);
if (params.get('k')) store.set('token', token);

if (!token) {
  $('#pairing').hidden = false;
} else {
  if (!params.get('k')) history.replaceState(null, '', `/?k=${encodeURIComponent(token)}`);
  $('#manifest').href = `/manifest.webmanifest?k=${encodeURIComponent(token)}`;
  start();
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Browser';
}

function start() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const conn = new Connection(`${proto}://${location.host}/ws?k=${encodeURIComponent(token)}&name=${encodeURIComponent(deviceName())}`);
  const send = (msg) => conn.send(msg);
  const trails = new Trails($('#trails'));
  let lastPoint = { x: 0, y: 0 };
  let backendStatus = null;
  let version = null;
  let macName = null;

  // Clicks also ripple on the phone, where the finger was.
  const emit = (msg) => {
    send(msg);
    if (msg.t === 'click') trails.ripple(lastPoint.x, lastPoint.y, msg.b !== 'left');
  };
  const trailHooks = (surface) => ({
    begin: () => surface.classList.add('used'),
    point: (id, x, y) => {
      lastPoint = { x, y };
      if (settings.trails) trails.add(id, x, y);
    },
    lift: (id) => trails.lift(id),
  });

  // ── Surfaces ──────────────────────────────────────────────────────────
  const pad = $('#pad');
  bindSurface(pad, new TrackpadRecognizer(emit, { feel }), trailHooks(pad));

  const couch = $('#couch');
  // Thumbs travel less than fingers, so couch mode moves the pointer further.
  const couchEmit = (msg) => emit(msg.t === 'move' ? { ...msg, dx: msg.dx * 1.35, dy: msg.dy * 1.35 } : msg);
  bindSurface(couch, new CouchRecognizer(couchEmit, { feel }), trailHooks(couch));

  const strip = $('#strip');
  bindSurface(strip, new StripRecognizer(send, { feel }), {
    begin: () => strip.classList.add('active'),
    lift: () => strip.classList.remove('active'),
  });
  for (const b of document.querySelectorAll('.couch-bar [data-media]')) onTap(b, () => (send({ t: 'media', k: b.dataset.media }), feel('tap')));
  for (const b of document.querySelectorAll('.couch-bar [data-key]')) onTap(b, () => (send({ t: 'key', k: b.dataset.key }), feel('tap')));

  // ── Keys, wheel, smart layout ─────────────────────────────────────────
  const keys = new Keys({
    root: $('[data-view="keys"]'),
    send,
    feel,
    live: settings.liveTyping,
    onLiveChange: (on) => {
      settings.liveTyping = on;
      saveSettings();
    },
  });
  const wheel = new WheelView({ root: $('[data-view="wheel"]'), send, feel });
  const smart = new Smart({
    strip: $('#smart-strip'),
    panel: $('#smart-panel'),
    tabLabel: $('#tab-app-label'),
    send,
    feel,
    onThen: (then) => {
      if (then === 'keys') {
        showView('keys');
        keys.focus();
      }
    },
  });

  // ── Views ─────────────────────────────────────────────────────────────
  const app = $('#app');
  function showView(name) {
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.dataset.view === name);
    for (const b of document.querySelectorAll('#tabbar [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    app.dataset.current = name;
    if (name !== 'keys') $('#type-field').blur();
    if (name === 'wheel') send({ t: 'getVolume' });
    settings.view = name;
    saveSettings();
  }
  for (const b of document.querySelectorAll('#tabbar [data-tab]')) {
    b.addEventListener('click', () => {
      showView(b.dataset.tab);
      feel('tick');
    });
  }
  onTap($('#app-chip'), () => showView('app'));
  showView(settings.view);

  // Keep the layout above the on-screen keyboard.
  const vv = window.visualViewport;
  const fit = () => {
    const h = vv ? vv.height : window.innerHeight;
    app.style.height = `${h}px`;
    app.style.transform = vv && vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    document.body.classList.toggle('kb', !!vv && window.innerHeight - vv.height > 120);
  };
  vv?.addEventListener('resize', fit);
  vv?.addEventListener('scroll', fit);
  window.addEventListener('resize', fit);
  fit();

  // ── Settings ──────────────────────────────────────────────────────────
  const macSettings = () => {
    const th = themeById(settings.theme);
    return {
      t: 'settings',
      pointerSpeed: settings.pointerSpeed,
      scrollSpeed: settings.scrollSpeed,
      naturalScroll: settings.naturalScroll,
      beacon: settings.beacon,
      ripples: settings.ripples,
      accent: th.accent,
      accent2: th.accent2,
    };
  };

  function applyTheme() {
    const th = themeById(settings.theme);
    document.documentElement.dataset.theme = th.id;
    document.querySelector('meta[name="theme-color"]').content = th.chrome;
    trails.setStyle(th.trail);
    for (const b of document.querySelectorAll('.theme-btn')) b.setAttribute('aria-pressed', String(b.dataset.theme === th.id));
  }

  function applyAll() {
    applyTheme();
    trails.enabled = settings.trails;
    setHapticsEnabled(settings.haptics);
    $('#couch-wrap').classList.toggle('left', settings.stripLeft);
    send(macSettings());
  }

  const picker = $('#theme-picker');
  picker.innerHTML = THEMES.map(
    (t) => `<button class="theme-btn" data-theme="${t.id}" aria-pressed="false">
      <span class="sw-swatch" style="background:${t.id === 'glass' ? 'linear-gradient(135deg,#7e68ff,#ff6fb1 60%,#2bd6ff)' : t.chrome};--sw-trail:${t.trail.colors[0]};${t.id === 'ipod' || t.id === 'black' ? 'border-color:var(--line)' : ''}"></span>
      <span>${t.name}</span></button>`,
  ).join('');
  for (const b of picker.querySelectorAll('.theme-btn')) {
    b.addEventListener('click', () => {
      settings.theme = b.dataset.theme;
      saveSettings();
      applyAll();
      feel('tap');
    });
  }

  const ranges = [
    ['#s-pointer', '#o-pointer', 'pointerSpeed'],
    ['#s-scroll', '#o-scroll', 'scrollSpeed'],
  ];
  for (const [inp, out, key] of ranges) {
    const el = $(inp);
    el.value = settings[key];
    $(out).textContent = `${Number(settings[key]).toFixed(2)}×`;
    el.addEventListener('input', () => {
      settings[key] = Number(el.value);
      $(out).textContent = `${settings[key].toFixed(2)}×`;
      saveSettings();
      send(macSettings());
    });
  }
  const toggles = [
    ['#s-natural', 'naturalScroll'],
    ['#s-trails', 'trails'],
    ['#s-ripples', 'ripples'],
    ['#s-beacon', 'beacon'],
    ['#s-haptics', 'haptics'],
    ['#s-left', 'stripLeft'],
  ];
  for (const [sel, key] of toggles) {
    const el = $(sel);
    el.checked = settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.checked;
      saveSettings();
      applyAll();
    });
  }

  const sheets = { settings: $('#settings'), install: $('#install') };
  const backdrop = $('#backdrop');
  const openSheet = (name) => {
    for (const [n, el] of Object.entries(sheets)) el.hidden = n !== name;
    backdrop.hidden = false;
  };
  const closeSheets = () => {
    for (const el of Object.values(sheets)) el.hidden = true;
    backdrop.hidden = true;
  };
  $('#open-settings').addEventListener('click', () => {
    updateAbout();
    openSheet('settings');
  });
  $('#settings-done').addEventListener('click', closeSheets);
  $('#install-done').addEventListener('click', () => {
    store.set('installTipShown', true);
    closeSheets();
  });
  backdrop.addEventListener('click', closeSheets);

  function updateAbout() {
    const parts = [`Rackpad ${version ?? ''}`.trim()];
    if (conn.latency !== null) parts.push(`${conn.latency} ms to your Mac`);
    $('#about').textContent = parts.join(' · ');
  }

  applyAll();

  // ── Connection & status ───────────────────────────────────────────────

  function renderStatus() {
    const s = conn.state;
    $('#conn').dataset.state = s;
    $('#mac-name').textContent = s === 'open' && macName ? macName : s === 'closed' ? 'Reconnecting…' : s === 'unauthorized' ? 'Not paired' : 'Connecting…';
    const banner = $('#banner');
    let text = null;
    let info = false;
    const b = backendStatus;
    if (s === 'open' && b) {
      if (b.kind === 'dry-run') {
        text = 'Dry run: your Mac logs what you do instead of doing it.';
        info = true;
      } else if (b.error) text = `Mac: ${b.error}`;
      else if (!b.ready) text = 'Starting Rackpad on your Mac…';
      else if (!b.trusted) text = 'One more step on your Mac: System Settings → Privacy & Security → Accessibility → switch on the app you started Rackpad from.';
    }
    banner.hidden = !text;
    banner.textContent = text ?? '';
    banner.classList.toggle('info', info);
  }

  conn.addEventListener('state', (e) => {
    renderStatus();
    if (e.detail === 'open') send(macSettings());
    if (e.detail === 'unauthorized') {
      $('#pairing-msg').textContent = "This phone's pairing code is no longer valid. Scan the QR code on your Mac again.";
      $('#pairing').hidden = false;
    }
  });
  conn.addEventListener('latency', updateAbout);
  conn.addEventListener('message', (e) => {
    const msg = e.detail;
    switch (msg.t) {
      case 'welcome':
        version = msg.version;
        macName = msg.mac?.name;
        backendStatus = msg.backend;
        setContext(msg);
        renderStatus();
        maybeShowInstallTip();
        break;
      case 'status':
        backendStatus = msg.backend;
        renderStatus();
        break;
      case 'context':
        setContext(msg);
        break;
      case 'volume':
        wheel.showVolume(msg);
        break;
      default:
        break;
    }
  });

  function setContext({ app: frontApp, profile }) {
    if (!profile) return;
    smart.set({ app: frontApp ?? {}, profile });
    const chip = $('#app-chip');
    chip.hidden = !frontApp?.name;
    $('#app-name').textContent = frontApp?.name ?? '';
    const img = $('#app-icon');
    if (frontApp?.icon) img.src = frontApp.icon;
    else img.removeAttribute('src');
  }

  function maybeShowInstallTip() {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    if (ios && !standalone && !store.get('installTipShown', false)) setTimeout(() => openSheet('install'), 1200);
  }

  conn.connect();
  window.rackpad = { conn, settings, showView }; // handy from the console
}
