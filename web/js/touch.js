// DOM glue: feeds touches into a recognizer, and makes buttons that act
// instantly on touch without stealing focus (so the keyboard stays up).

const points = (list) => Array.from(list, (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));

// `hooks.point(id, x, y)` and `hooks.lift(id)` let the trails follow fingers.
export function bindSurface(el, rec, hooks = {}) {
  const now = () => performance.now();
  const track = (e) => {
    for (const t of e.changedTouches) hooks.point?.(t.identifier, t.clientX, t.clientY);
  };
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    hooks.begin?.();
    track(e);
    rec.start(points(e.targetTouches), now());
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    e.preventDefault();
    track(e);
    rec.move(points(e.targetTouches), now());
  }, { passive: false });
  el.addEventListener('touchend', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) hooks.lift?.(t.identifier);
    rec.end(points(e.targetTouches), now());
  }, { passive: false });
  el.addEventListener('touchcancel', (e) => {
    for (const t of e.changedTouches) hooks.lift?.(t.identifier);
    rec.cancel();
  });

  // A mouse works too, which makes the UI easy to try on a laptop.
  let mouseDown = false;
  el.addEventListener('mousedown', (e) => {
    if (e.sourceCapabilities?.firesTouchEvents) return;
    mouseDown = true;
    hooks.begin?.();
    hooks.point?.('m', e.clientX, e.clientY);
    rec.start([{ id: 'm', x: e.clientX, y: e.clientY }], now());
  });
  window.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    hooks.point?.('m', e.clientX, e.clientY);
    rec.move([{ id: 'm', x: e.clientX, y: e.clientY }], now());
  });
  window.addEventListener('mouseup', () => {
    if (!mouseDown) return;
    mouseDown = false;
    hooks.lift?.('m');
    rec.end([], now());
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Acts on touchstart→touchend (no 300ms wait, no focus change), and on click
// for mice. Cancels if the finger slides off. Buttons inside something that
// scrolls pass `{ scrolls: true }` and use plain clicks, so the scroll works.
export function onTap(el, fn, { scrolls = false } = {}) {
  if (scrolls) {
    el.addEventListener('click', fn);
    return;
  }
  let start = null;
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    start = { x: t.clientX, y: t.clientY };
    el.classList.add('pressed');
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    const t = e.changedTouches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 24) {
      start = null;
      el.classList.remove('pressed');
    }
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    e.preventDefault();
    el.classList.remove('pressed');
    if (start) fn(e);
    start = null;
  }, { passive: false });
  el.addEventListener('touchcancel', () => {
    start = null;
    el.classList.remove('pressed');
  });
  el.addEventListener('click', (e) => {
    if (e.pointerType === 'touch') return;
    fn(e);
  });
  el.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus where it is
}
