import { shortestAngleDelta } from './geo';
import type { RoutePoint, TrackPoint } from './types';

// Interpolates position between buffered points. Holds at the last point
// if playback catches up before the next poll — no new data means no
// guessing at position.
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
      // `b` is the first point after a GPS-loss discontinuity — gliding
      // from `a` to `b` would draw a fake line through the tunnel/building.
      // Hold at `a`, then snap.
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
