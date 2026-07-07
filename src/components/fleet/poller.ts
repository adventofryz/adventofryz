import { offsetMeters } from './geo';
import { positionAtDistance } from './simulate';
import type { FleetVehicle } from './simulate';
import type { TrackPoint, VehicleMeta } from './types';

// Mirrors the real system's shape: each batch re-sends the tail of the
// previous one (OVERLAP_MS) instead of picking up exactly where it left
// off. merge.ts copes with that, plus the failure modes simulated below.
export const SAMPLE_INTERVAL_MS = 500;
export const OVERLAP_MS = 1500;

// Per-poll odds of each failure mode (moving vehicles only), calibrated
// against real telematics failure rates rather than picked for visual
// density:
//   - DROP: a missed report from an ordinary cellular hiccup (~99.5%
//     delivery reliability).
//   - OUTLIER: a lone multipath-reflected ping (tall buildings, urban
//     canyons) that self-corrects — more common than losing the fix outright.
//   - GPS_LOSS: signal lost long enough to relocate on reacquisition —
//     needs real physical obstruction (tunnel, garage), so it's the rarest.
// GPS_LOSS and OUTLIER are the two that can visibly teleport a vehicle off
// its route.
const DROP_CHANCE = 0.005;
const GPS_LOSS_CHANCE = 0.0015;
const OUTLIER_CHANCE = 0.003;

// Fraction of the sample window a GPS-loss poll swallows from the front —
// the "underground" stretch it couldn't report during.
const GPS_LOSS_FRACTION = 0.5;

// Reacquiring a fix doesn't land back on the true route — offsets the
// resumed stretch laterally until the next poll re-syncs (a second, smaller
// corrective jump — also real). Sized to clear merge.ts's plausible-speed
// threshold even for a slow vehicle.
const GPS_LOSS_OFFSET_M = 180;

// Lateral fling on a single interior point — a lone bad ping (multipath
// reflection), not a sustained relocation.
const OUTLIER_OFFSET_M = 90;

// `sinceT` may be negative — used once at startup to seed a buffer ending
// at t=0, so playback has data to interpolate through immediately.
export function pollFleet(fleet: FleetVehicle[], sinceT: number, nowT: number): Map<string, TrackPoint[]> {
  const windowStart = sinceT - OVERLAP_MS;
  const batch = new Map<string, TrackPoint[]>();

  for (const vehicle of fleet) {
    if (vehicle.idle) {
      const p = positionAtDistance(vehicle, vehicle.startOffsetMeters);
      batch.set(vehicle.id, [{ t: nowT, ...p }]);
      continue;
    }

    if (Math.random() < DROP_CHANCE) {
      batch.set(vehicle.id, []);
      continue;
    }

    const gpsLoss = Math.random() < GPS_LOSS_CHANCE;
    const sampleStart = gpsLoss ? windowStart + (nowT - windowStart) * GPS_LOSS_FRACTION : windowStart;

    const points: TrackPoint[] = [];
    for (let t = sampleStart; t <= nowT; t += SAMPLE_INTERVAL_MS) {
      const distance = vehicle.startOffsetMeters + (t / 1000) * vehicle.speedMps;
      points.push({ t, ...positionAtDistance(vehicle, distance) });
    }

    if (gpsLoss && points.length > 0) {
      const angle = Math.random() * Math.PI * 2;
      const dx = Math.cos(angle) * GPS_LOSS_OFFSET_M;
      const dy = Math.sin(angle) * GPS_LOSS_OFFSET_M;
      for (let i = 0; i < points.length; i++) {
        points[i] = { ...points[i], ...offsetMeters(points[i], dx, dy) };
      }
    }

    if (!gpsLoss && points.length > 2 && Math.random() < OUTLIER_CHANCE) {
      const i = 1 + Math.floor(Math.random() * (points.length - 2));
      const angle = Math.random() * Math.PI * 2;
      const flung = offsetMeters(points[i], Math.cos(angle) * OUTLIER_OFFSET_M, Math.sin(angle) * OUTLIER_OFFSET_M);
      points[i] = { ...points[i], ...flung };
    }

    batch.set(vehicle.id, points);
  }

  return batch;
}

// Static metadata, as if from a separate API — fetched once, not part of
// the periodic position poll.
export function buildMetadata(fleet: FleetVehicle[]): Map<string, VehicleMeta> {
  const meta = new Map<string, VehicleMeta>();
  for (const vehicle of fleet) {
    meta.set(vehicle.id, {
      id: vehicle.id,
      plate: vehicle.id.replace('VH-', 'SF-'),
      model: 'Fleet EV',
    });
  }
  return meta;
}
