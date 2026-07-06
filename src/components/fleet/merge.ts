import type { TrackPoint } from './types';

// Stitches an incoming trackingPath chunk onto a vehicle's buffer. Consecutive
// polls overlap on purpose (see poller.ts) — points already in the buffer get
// re-sent alongside genuinely new ones. Dedup by `t`: only points strictly
// newer than the buffer's last known point are appended, so already-consumed
// history is never rewritten and the playback cursor never has to jump back.
export function mergeTrackingPath(buffer: TrackPoint[], incoming: TrackPoint[]): TrackPoint[] {
  if (incoming.length === 0) return buffer;
  if (buffer.length === 0) return incoming.slice();

  const lastKnownT = buffer[buffer.length - 1].t;
  const newPoints = incoming.filter((p) => p.t > lastKnownT);

  return newPoints.length > 0 ? buffer.concat(newPoints) : buffer;
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
