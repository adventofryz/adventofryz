import { positionAtDistance } from './simulate';
import type { FleetVehicle } from './simulate';
import type { TrackPoint, VehicleMeta } from './types';

// Mirrors the real system's shape: vehicle position data arrives in periodic
// batches, each a `trackingPath` chunk that deliberately re-sends the tail of
// the previous batch (OVERLAP_MS) rather than picking up exactly where the
// last one ended. The merge step (merge.ts) is what has to cope with that.
export const SAMPLE_INTERVAL_MS = 500;
export const OVERLAP_MS = 1500;

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

    const points: TrackPoint[] = [];
    for (let t = windowStart; t <= nowT; t += SAMPLE_INTERVAL_MS) {
      const distance = vehicle.startOffsetMeters + (t / 1000) * vehicle.speedMps;
      points.push({ t, ...positionAtDistance(vehicle, distance) });
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
