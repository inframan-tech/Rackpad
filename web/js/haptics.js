// Haptics. Android: the Vibration API. iPhone has no Vibration API for web
// pages, but since iOS 18 flipping an <input type="checkbox" switch> plays the
// system's selection tick, so that's what we do (one light tick, any kind).
// iOS only plays it while handling a lifted finger or a click, so the ticks
// asked for mid-gesture (scroll strip notches, a hold) stay silent there.

let enabled = true;

const PATTERNS = { tick: 5, tap: 8, tap2: [8, 40, 8], grab: 18, heavy: 22 };

export function setHapticsEnabled(on) {
  enabled = on;
}

// A fresh, unrendered switch each time, flipped through its label.
function iosTick() {
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.appendChild(input);
  document.body.appendChild(label);
  label.click();
  label.remove();
}

export function feel(kind = 'tap') {
  if (!enabled) return;
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(PATTERNS[kind] ?? 8);
    return;
  }
  try {
    iosTick();
  } catch {
    // Not available; stay quiet.
  }
}
