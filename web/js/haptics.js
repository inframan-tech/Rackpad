// Haptics. Android: the Vibration API. iPhone has no Vibration API for web
// pages, but since iOS 18 toggling an <input type="checkbox" switch> plays the
// system's selection tick, so that's what we do (one light tick, any kind).

let enabled = true;
let label = null;

const PATTERNS = { tick: 5, tap: 8, tap2: [8, 40, 8], grab: 18, heavy: 22 };

export function setHapticsEnabled(on) {
  enabled = on;
}

function iosSwitch() {
  if (label) return label;
  label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  return label;
}

export function feel(kind = 'tap') {
  if (!enabled) return;
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(PATTERNS[kind] ?? 8);
    return;
  }
  try {
    iosSwitch().click();
  } catch {
    // Not available; stay quiet.
  }
}
