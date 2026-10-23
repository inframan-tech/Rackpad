// Click-wheel math: turning the ring produces whole notches (one volume step
// each); a tap on the ring or the centre is a button press.

export const NOTCH = Math.PI / 8; // 16 notches per turn: one turn = silent to full

export function angleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

// Screen y points down, so atan2 grows clockwise: clockwise = louder.
export class WheelTracker {
  constructor(notch = NOTCH) {
    this.notch = notch;
    this.last = 0;
    this.acc = 0;
    this.travel = 0;
  }

  start(angle) {
    this.last = angle;
    this.acc = 0;
    this.travel = 0;
  }

  // Returns whole notches turned since the last call (+ clockwise).
  move(angle) {
    const d = angleDelta(this.last, angle);
    this.last = angle;
    this.acc += d;
    this.travel += Math.abs(d);
    let steps = 0;
    while (this.acc >= this.notch) {
      steps++;
      this.acc -= this.notch;
    }
    while (this.acc <= -this.notch) {
      steps--;
      this.acc += this.notch;
    }
    return steps;
  }
}

// Which part of the wheel a point is on. `inner` is the centre button's
// radius and `outer` the wheel's, both in px.
export function zoneAt(x, y, cx, cy, inner, outer) {
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  if (r > outer) return null;
  if (r <= inner) return 'center';
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}
