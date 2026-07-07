import { offsetMeters } from './geo';
import { positionAtDistance } from './simulate';
import type { FleetVehicle } from './simulate';
import type { TrackPoint, VehicleMeta } from './types';

// Mirrors the real system's shape: vehicle position data arrives in periodic
// batches, each a `trackingPath` chunk that deliberately re-sends the tail of
// the previous batch (OVERLAP_MS) rather than picking up exactly where the
// last one ended. The merge step (merge.ts) is what has to cope with that —
// plus the messier failure modes real devices produce, simulated below.
export const SAMPLE_INTERVAL_MS = 500;
export const OVERLAP_MS = 1500;

// Per-poll odds of each failure mode (independent, moving vehicles only).
// Rare enough that a 100-vehicle fleet still reads as flowing, but frequent
// enough that all four merge-side cases (empty/dedupe/gap/outlier) are
// visibly exercised within a few poll cycles.
const DROP_CHANCE = 0.05;
const GPS_LOSS_CHANCE = 0.05;
const OUTLIER_CHANCE = 0.04;

// How much of the sample window a GPS-loss poll swallows from the front —
// standing in for the "underground" stretch the device couldn't report
// during.
const GPS_LOSS_FRACTION = 0.5;

// Reacquiring a fix after a blackout doesn't land back exactly on the true
// route — dead-reckoning/multipath error offsets the whole resumed stretch
// by a fixed lateral amount (until the next normal poll re-syncs to the true
// route, which reads as a second, smaller corrective jump — also real).
// Sized well above OUTLIER_OFFSET_M's speed-over-one-sample so it clears
// merge.ts's plausible-speed threshold even for a slow vehicle whose true
// motion happens to point opposite the offset.
const GPS_LOSS_OFFSET_M = 180;

// Lateral fling applied to a single interior point to simulate multipath
// reflection off buildings — a lone bad ping, not a sustained relocation.
const OUTLIER_OFFSET_M = 90;

// `sinceT` may be negative — used once at startup to seed a vehicle's buffer
// with a window ending at t=0, so playback (which renders on a delay, see
// FleetMap.tsx) has real data to interpolate through immediately instead of
// freezing until the first real poll arrives.
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

// Flavor only, not wired to actual origin/destination — gives each vehicle a
// reason to be out there instead of just being an anonymous moving triangle.
const JOBS = ['Food delivery', 'Hospital transport', 'Courier run', 'Grocery delivery', 'Ride share', 'Package delivery'];

// Static vehicle metadata, as if sourced from a separate API — fetched once,
// not part of the periodic position poll.
export function buildMetadata(fleet: FleetVehicle[]): Map<string, VehicleMeta> {
  const meta = new Map<string, VehicleMeta>();
  for (const vehicle of fleet) {
    meta.set(vehicle.id, {
      id: vehicle.id,
      plate: vehicle.id.replace('VH-', 'SF-'),
      model: 'Fleet EV',
      job: JOBS[Math.floor(Math.random() * JOBS.length)],
    });
  }
  return meta;
}
