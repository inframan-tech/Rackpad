// Smart layouts: the phone's controls change with the app in front on the Mac.
//
// Each profile matches on bundle id (and optionally the focused window title,
// for web apps like Meet that live inside a browser). A control does exactly
// one thing: `keys` (a shortcut), `media` (a media key) or `sys` (a system
// action such as Mission Control). `then: 'keys'` tells the phone to jump to
// the keyboard afterwards, e.g. after focusing the address bar.

const BROWSERS = [
  'com.apple.Safari', 'com.apple.SafariTechnologyPreview',
  'com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.canary',
  'org.chromium.Chromium', 'company.thebrowser.Browser', 'company.thebrowser.dia',
  'org.mozilla.firefox', 'org.mozilla.firefoxdeveloperedition', 'app.zen-browser.zen',
  'com.microsoft.edgemac', 'com.brave.Browser', 'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera', 'com.kagi.kagimacOS',
];

const slides = (play) => [
  { id: 'next', label: 'Next', icon: 'chevron-right', keys: 'right', hero: true },
  { id: 'prev', label: 'Back', icon: 'chevron-left', keys: 'left' },
  { id: 'play', label: 'Play', icon: 'presentation', keys: play },
  { id: 'black', label: 'Black screen', icon: 'square', keys: 'b' },
  { id: 'end', label: 'End show', icon: 'log-out', keys: 'esc' },
];

export const PROFILES = [
  {
    id: 'meet', kind: 'meeting', title: 'Google Meet',
    match: { bundles: BROWSERS, title: /\bMeet\s+[-–—]|Google Meet/i },
    controls: [
      { id: 'mute', label: 'Mute', icon: 'mic', keys: 'cmd+d', hero: true },
      { id: 'camera', label: 'Camera', icon: 'video', keys: 'cmd+e' },
      { id: 'hand', label: 'Raise hand', icon: 'hand', keys: 'ctrl+cmd+h' },
    ],
  },
  {
    id: 'slides-web', kind: 'slides', title: 'Google Slides',
    match: { bundles: BROWSERS, title: /Google Slides/i },
    controls: slides('cmd+return'),
  },
  {
    id: 'youtube', kind: 'media', title: 'YouTube',
    match: { bundles: BROWSERS, title: /YouTube/i },
    controls: [
      { id: 'play', label: 'Play / Pause', icon: 'play-pause', keys: 'k', hero: true },
      { id: 'back', label: '10s back', icon: 'rewind-10', keys: 'j' },
      { id: 'fwd', label: '10s ahead', icon: 'forward-10', keys: 'l' },
      { id: 'full', label: 'Fullscreen', icon: 'maximize', keys: 'f' },
      { id: 'captions', label: 'Captions', icon: 'captions', keys: 'c' },
      { id: 'mute', label: 'Mute video', icon: 'volume-x', keys: 'm' },
    ],
  },
  {
    id: 'netflix', kind: 'media', title: 'Netflix',
    match: { bundles: BROWSERS, title: /Netflix/i },
    controls: [
      { id: 'play', label: 'Play / Pause', icon: 'play-pause', keys: 'space', hero: true },
      { id: 'back', label: '10s back', icon: 'rewind-10', keys: 'left' },
      { id: 'fwd', label: '10s ahead', icon: 'forward-10', keys: 'right' },
      { id: 'full', label: 'Fullscreen', icon: 'maximize', keys: 'f' },
    ],
  },
  {
    id: 'zoom', kind: 'meeting', title: 'Zoom',
    match: { bundles: ['us.zoom.xos'] },
    controls: [
      { id: 'mute', label: 'Mute', icon: 'mic', keys: 'cmd+shift+a', hero: true },
      { id: 'camera', label: 'Camera', icon: 'video', keys: 'cmd+shift+v' },
      { id: 'hand', label: 'Raise hand', icon: 'hand', keys: 'alt+y' },
      { id: 'share', label: 'Share screen', icon: 'screen-share', keys: 'cmd+shift+s' },
      { id: 'chat', label: 'Chat', icon: 'message', keys: 'cmd+shift+h' },
    ],
  },
  {
    id: 'teams', kind: 'meeting', title: 'Teams',
    match: { bundles: ['com.microsoft.teams2', 'com.microsoft.teams'] },
    controls: [
      { id: 'mute', label: 'Mute', icon: 'mic', keys: 'cmd+shift+m', hero: true },
      { id: 'camera', label: 'Camera', icon: 'video', keys: 'cmd+shift+o' },
      { id: 'hand', label: 'Raise hand', icon: 'hand', keys: 'cmd+shift+k' },
      { id: 'share', label: 'Share screen', icon: 'screen-share', keys: 'cmd+shift+e' },
    ],
  },
  {
    id: 'keynote', kind: 'slides', title: 'Keynote',
    match: { bundles: ['com.apple.iWork.Keynote'] },
    controls: slides('cmd+alt+p'),
  },
  {
    id: 'powerpoint', kind: 'slides', title: 'PowerPoint',
    match: { bundles: ['com.microsoft.Powerpoint'] },
    controls: slides('cmd+shift+return'),
  },
  {
    id: 'music', kind: 'media', title: 'Music',
    match: { bundles: ['com.spotify.client', 'com.apple.Music', 'com.apple.podcasts'] },
    controls: [
      { id: 'play', label: 'Play / Pause', icon: 'play-pause', media: 'playpause', hero: true },
      { id: 'prev', label: 'Previous', icon: 'skip-back', media: 'prev' },
      { id: 'next', label: 'Next', icon: 'skip-forward', media: 'next' },
      { id: 'voldown', label: 'Quieter', icon: 'volume-1', media: 'voldown' },
      { id: 'volup', label: 'Louder', icon: 'volume-2', media: 'volup' },
    ],
  },
  {
    id: 'video', kind: 'media', title: 'Video',
    match: { bundles: ['com.apple.QuickTimePlayerX', 'com.colliderli.iina', 'org.videolan.vlc', 'com.apple.TV'] },
    controls: [
      { id: 'play', label: 'Play / Pause', icon: 'play-pause', keys: 'space', hero: true },
      { id: 'back', label: 'Skip back', icon: 'rewind-10', keys: 'left' },
      { id: 'fwd', label: 'Skip ahead', icon: 'forward-10', keys: 'right' },
      { id: 'full', label: 'Fullscreen', icon: 'maximize', keys: 'ctrl+cmd+f' },
    ],
  },
  {
    id: 'browser', kind: 'grid', title: 'Browser',
    match: { bundles: BROWSERS },
    controls: [
      { id: 'back', label: 'Back', icon: 'arrow-left', keys: 'cmd+[' },
      { id: 'forward', label: 'Forward', icon: 'arrow-right', keys: 'cmd+]' },
      { id: 'reload', label: 'Reload', icon: 'rotate-cw', keys: 'cmd+r' },
      { id: 'prevTab', label: 'Prev tab', icon: 'chevron-left', keys: 'ctrl+shift+tab' },
      { id: 'nextTab', label: 'Next tab', icon: 'chevron-right', keys: 'ctrl+tab' },
      { id: 'newTab', label: 'New tab', icon: 'plus', keys: 'cmd+t', then: 'keys' },
      { id: 'closeTab', label: 'Close tab', icon: 'x', keys: 'cmd+w' },
      { id: 'reopen', label: 'Reopen tab', icon: 'rotate-ccw', keys: 'cmd+shift+t' },
      { id: 'address', label: 'Address bar', icon: 'link', keys: 'cmd+l', then: 'keys' },
      { id: 'find', label: 'Find', icon: 'search', keys: 'cmd+f', then: 'keys' },
      { id: 'zoomIn', label: 'Zoom in', icon: 'zoom-in', keys: 'cmd+=' },
      { id: 'zoomOut', label: 'Zoom out', icon: 'zoom-out', keys: 'cmd+-' },
    ],
  },
  {
    id: 'default', kind: 'grid', title: 'Mac',
    match: {},
    controls: [
      { id: 'mission', label: 'Mission Control', icon: 'layout', sys: 'missionControl' },
      { id: 'expose', label: 'App windows', icon: 'layers', sys: 'appExpose' },
      { id: 'spotlight', label: 'Spotlight', icon: 'search', keys: 'cmd+space', then: 'keys' },
      { id: 'switch', label: 'Last app', icon: 'app-window', keys: 'cmd+tab' },
      { id: 'copy', label: 'Copy', icon: 'copy', keys: 'cmd+c' },
      { id: 'paste', label: 'Paste', icon: 'clipboard', keys: 'cmd+v' },
      { id: 'undo', label: 'Undo', icon: 'undo', keys: 'cmd+z' },
      { id: 'redo', label: 'Redo', icon: 'redo', keys: 'cmd+shift+z' },
      { id: 'closeWindow', label: 'Close window', icon: 'x', keys: 'cmd+w' },
      { id: 'fullscreen', label: 'Fullscreen', icon: 'maximize', keys: 'ctrl+cmd+f' },
      { id: 'desktopLeft', label: 'Desktop left', icon: 'chevron-left', sys: 'desktopLeft' },
      { id: 'desktopRight', label: 'Desktop right', icon: 'chevron-right', sys: 'desktopRight' },
    ],
  },
];

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

export function profileFor(app) {
  const bundle = app?.bundleId ?? '';
  const title = app?.title ?? '';
  for (const p of PROFILES) {
    const m = p.match;
    if (m.bundles && !m.bundles.includes(bundle)) continue;
    if (m.title && !m.title.test(title)) continue;
    return p;
  }
  return BY_ID.get('default');
}

// What the phone needs to draw a profile; control ids are namespaced so a tap
// can be resolved even if the Mac's front app changed in the meantime.
export function publicProfile(p) {
  const controls = p.controls.map((c) => ({
    id: `${p.id}.${c.id}`,
    label: c.label,
    icon: c.icon,
    ...(c.hero ? { hero: true } : {}),
    ...(c.then ? { then: c.then } : {}),
  }));
  return { id: p.id, kind: p.kind, title: p.title, controls };
}

export function findControl(fullId) {
  if (typeof fullId !== 'string') return null;
  const dot = fullId.indexOf('.');
  if (dot < 0) return null;
  const p = BY_ID.get(fullId.slice(0, dot));
  return p?.controls.find((c) => c.id === fullId.slice(dot + 1)) ?? null;
}
