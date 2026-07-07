import { haversineMeters } from './geo';
import type { TrackPoint } from './types';

export type MergeEvent = 'appended' | 'empty' | 'deduped' | 'gap' | 'outlier';

export interface MergeResult {
  buffer: TrackPoint[];
  events: MergeEvent[];
}

// A point-to-point implied speed above this is never genuine driving (the
// fleet's fastest vehicle tops out at 14 m/s, see MAX_SPEED_MPS in
// simulate.ts) — it's either a transient bad ping or a real GPS-loss
// discontinuity. Which one it is gets decided by looking at what follows.
const MAX_PLAUSIBLE_MPS = 16;

// Stitches an incoming trackingPath chunk onto a vehicle's buffer, coping
// with everything a real tracking feed does to a naive stitcher:
//   - an empty/null poll (network hiccup) — buffer holds, nothing to append.
//   - re-sent tail/overlap (see poller.ts's OVERLAP_MS) — deduped by `t`,
//     never rewriting already-consumed history.
//   - a lone bad ping (multipath near buildings) — implausible speed in,
//     implausible speed back out; rejected rather than stitched in.
//   - a sustained relocation (GPS reacquired post-tunnel/bridge somewhere
//     else) — implausible speed in, but it *stays* there; accepted as a real
//     jump (`gap: true`) so playback snaps instead of gliding through it.
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
      // A lone spike snaps back near `prev`'s own trajectory once the next
      // ping arrives; a real relocation keeps going from where it landed.
      // With no next point yet to check, don't speculatively discard the
      // newest data — accept it as a jump; a future point would contradict
      // it if it were actually a spike.
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

// Bounds memory by dropping points well behind the current playback cursor,
// keeping one point before the cutoff so interpolation across the trim point
// stays continuous.
export function trimBuffer(buffer: TrackPoint[], cursorT: number, keepMs: number): TrackPoint[] {
  const cutoff = cursorT - keepMs;
  const idx = buffer.findIndex((p) => p.t >= cutoff);
  if (idx <= 0) return buffer;
  return buffer.slice(idx - 1);
}
