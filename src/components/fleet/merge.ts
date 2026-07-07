import { haversineMeters } from './geo';
import type { TrackPoint } from './types';

export type MergeEvent = 'appended' | 'empty' | 'deduped' | 'gap' | 'outlier';

export interface MergeResult {
  buffer: TrackPoint[];
  events: MergeEvent[];
}

// Above this implied speed, it's never genuine driving (top speed is 14
// m/s, see MAX_SPEED_MPS in simulate.ts) — either a bad ping or a real
// GPS-loss jump, decided by looking at what follows.
const MAX_PLAUSIBLE_MPS = 16;

// Stitches an incoming trackingPath chunk onto a vehicle's buffer:
//   - empty poll — buffer holds, nothing appended.
//   - re-sent tail/overlap (poller.ts's OVERLAP_MS) — deduped by `t`.
//   - a lone bad ping — implausible speed in and back out; rejected.
//   - a sustained relocation — implausible speed in, but it stays there;
//     accepted as a real jump (`gap: true`) so playback snaps, not glides.
export function mergeTrackingPath(buffer: TrackPoint[], incoming: TrackPoint[]): MergeResult {
  if (incoming.length === 0) return { buffer, events: ['empty'] };

  const lastKnownT = buffer.length > 0 ? buffer[buffer.length - 1].t : -Infinity;
  const newPoints = incoming.filter((p) => p.t > lastKnownT);
  if (newPoints.length === 0) return { buffer, events: ['deduped'] };

  const events: MergeEvent[] = [];
  if (newPoints.length < incoming.length) events.push('deduped');

  const result = buffer.slice();
  let prev = result.length > 0 ? result[result.length - 1] : undefined;

  for (let i = 0; i < newPoints.length; i++) {
    const point = newPoints[i];

    if (!prev) {
      result.push(point);
      prev = point;
      continue;
    }

    const dtSec = (point.t - prev.t) / 1000;
    const dist = haversineMeters(prev, point);
    const impliedSpeed = dtSec > 0 ? dist / dtSec : Infinity;

    if (impliedSpeed > MAX_PLAUSIBLE_MPS) {
      const next = newPoints[i + 1];
      // A lone spike snaps back near `prev`'s trajectory on the next ping;
      // a real relocation keeps going. With no next point yet, accept it
      // as a jump rather than speculatively discard it.
      const isLoneSpike = next !== undefined && haversineMeters(next, prev) < dist * 0.5;

      if (isLoneSpike) {
        events.push('outlier');
        continue;
      }

      events.push('gap');
      result.push({ ...point, gap: true });
      prev = point;
      continue;
    }

    result.push(point);
    prev = point;
  }

  if (events.length === 0) events.push('appended');
  return { buffer: result, events };
}

// Drops points well behind the playback cursor, keeping one before the
// cutoff so interpolation across the trim point stays continuous.
export function trimBuffer(buffer: TrackPoint[], cursorT: number, keepMs: number): TrackPoint[] {
  const cutoff = cursorT - keepMs;
  const idx = buffer.findIndex((p) => p.t >= cutoff);
  if (idx <= 0) return buffer;
  return buffer.slice(idx - 1);
}
