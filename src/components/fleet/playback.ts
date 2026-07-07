import { shortestAngleDelta } from './geo';
import type { RoutePoint, TrackPoint } from './types';

// Interpolates a vehicle's position between buffered points for the given
// simulated time. If playback catches up to the last buffered point before
// the next poll arrives, it holds there rather than extrapolating — a vehicle
// with no new data yet shouldn't appear to guess its own position.
export function interpolateAt(buffer: TrackPoint[], t: number): RoutePoint | null {
  if (buffer.length === 0) return null;

  const first = buffer[0];
  if (t <= first.t) return first;

  const last = buffer[buffer.length - 1];
  if (t >= last.t) return last;

  for (let i = 0; i < buffer.length - 1; i++) {
    const a = buffer[i];
    const b = buffer[i + 1];
    if (t >= a.t && t <= b.t) {
      // `b` is the first point after a detected GPS-loss discontinuity —
      // gliding smoothly from `a` to `b` would draw a fake straight line
      // through whatever's actually there (buildings, the tunnel itself).
      // Hold at `a` until the real jump happens, then snap.
      if (b.gap) return t >= b.t ? b : a;

      const span = b.t - a.t || 1;
      const frac = (t - a.t) / span;
      return {
        lat: a.lat + (b.lat - a.lat) * frac,
        lng: a.lng + (b.lng - a.lng) * frac,
        heading: a.heading + shortestAngleDelta(a.heading, b.heading) * frac,
      };
    }
  }

  return last;
}
