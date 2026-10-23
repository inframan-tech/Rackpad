// Key names and shortcut strings ("cmd+shift+t") → macOS virtual key codes.
// Codes are ANSI (US) positions; the native helper remaps printable characters
// to the user's actual keyboard layout, so Cmd+Z stays Cmd+Z on a German Mac.

export const NAMED_KEYS = {
  return: 36, enter: 36, tab: 48, space: 49, backspace: 51, delete: 51,
  escape: 53, esc: 53, forwarddelete: 117, del: 117,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

// Unshifted characters on a US keyboard.
const CHAR_CODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12,
  w: 13, e: 14, r: 15, y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22,
  5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31,
  u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41,
  '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50, ' ': 49,
};

// Shifted characters and the key they live on.
const SHIFTED = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};

const MOD_ALIASES = {
  cmd: 'cmd', command: 'cmd', meta: 'cmd', '⌘': 'cmd',
  shift: 'shift', '⇧': 'shift',
  alt: 'alt', opt: 'alt', option: 'alt', '⌥': 'alt',
  ctrl: 'ctrl', control: 'ctrl', '⌃': 'ctrl',
  fn: 'fn',
};

export const MODIFIERS = ['cmd', 'shift', 'alt', 'ctrl', 'fn'];

export function normalizeMod(name) {
  return MOD_ALIASES[String(name).toLowerCase()] ?? null;
}

// Resolves one key: a name ("left"), or a single printable character ("t", "{").
// Returns { code, char?, shift } or null.
export function resolveKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  const lower = key.toLowerCase();
  if (key.length > 1 && lower in NAMED_KEYS) return { code: NAMED_KEYS[lower], shift: false };
  if ([...key].length !== 1) return null;
  if (key in SHIFTED) {
    const base = SHIFTED[key];
    return { code: CHAR_CODES[base], char: base, shift: true };
  }
  if (lower in CHAR_CODES) {
    const isUpper = key !== lower;
    return { code: CHAR_CODES[lower], char: lower, shift: isUpper };
  }
  return null;
}

// "cmd+shift+[" → { code: 33, char: '[', mods: ['cmd', 'shift'] }
export function parseCombo(spec) {
  if (typeof spec !== 'string' || !spec) throw new Error('empty shortcut');
  // A trailing "+" is the plus key itself ("cmd++").
  const parts = spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+');
  const keyName = parts.pop();
  const mods = [];
  for (const p of parts) {
    const m = normalizeMod(p.trim());
    if (!m) throw new Error(`unknown modifier "${p}" in "${spec}"`);
    if (!mods.includes(m)) mods.push(m);
  }
  const key = resolveKey(keyName.length > 1 ? keyName.trim() : keyName);
  if (!key) throw new Error(`unknown key "${keyName}" in "${spec}"`);
  if (key.shift && !mods.includes('shift')) mods.push('shift');
  const out = { code: key.code, mods };
  if (key.char !== undefined) out.char = key.char;
  return out;
}

// Validates a modifier list coming from the phone.
export function cleanMods(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    const n = normalizeMod(m);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
