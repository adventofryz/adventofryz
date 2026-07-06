import { haversineMeters, offsetMeters } from './geo';
import type { RoutePoint } from './types';

export interface FleetVehicle {
  id: string;
  points: RoutePoint[];
  cumulative: number[]; // meters, cumulative[0] === 0, same length as points
  totalDistance: number;
  speedMps: number;
  startOffsetMeters: number; // phase offset so clones of the same route aren't in lockstep
  direction: 1 | -1;
  idle: boolean;
}

const IDLE_RATIO = 0.15;
const MIN_SPEED_MPS = 4; // ~14 km/h city driving
const MAX_SPEED_MPS = 14; // ~50 km/h
const JITTER_RADIUS_M = 12; // keeps clones visually distinct without leaving the road

function buildCumulative(points: RoutePoint[]): number[] {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  return cumulative;
}

export function createFleet(routes: RoutePoint[][], targetCount: number): FleetVehicle[] {
  const fleet: FleetVehicle[] = [];
  const clonesPerRoute = Math.ceil(targetCount / routes.length);
  let id = 0;

  outer: for (const route of routes) {
    // Cumulative distance only needs computing once per base route: a clone's
    // jitter offset is a uniform few-meter translation of every point, which
    // leaves segment-to-segment distances unchanged. Recomputing it per clone
    // was ~17x redundant haversine work and the main cause of a slow first load.
    const baseCumulative = buildCumulative(route);
    const totalDistance = baseCumulative[baseCumulative.length - 1] || 1;

    for (let clone = 0; clone < clonesPerRoute; clone++) {
      if (fleet.length >= targetCount) break outer;

      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * JITTER_RADIUS_M;
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;

      const points = route.map((p) => ({ ...offsetMeters(p, dx, dy), heading: p.heading }));

      fleet.push({
        id: `VH-${(id++).toString().padStart(4, '0')}`,
        points,
        cumulative: baseCumulative,
        totalDistance,
        speedMps: MIN_SPEED_MPS + Math.random() * (MAX_SPEED_MPS - MIN_SPEED_MPS),
        startOffsetMeters: Math.random() * totalDistance,
        direction: Math.random() < 0.5 ? 1 : -1,
        idle: Math.random() < IDLE_RATIO,
      });
    }
  }

  return fleet;
}

// Position + heading of a vehicle at a given distance travelled along its
// route. A route's start and end are usually nowhere near each other (just
// two random points joined by a shortest path), so simply wrapping back to
// the start at the end would be a teleport. Instead this reflects — the
// vehicle U-turns and drives back along the same route (ping-pong) — which
// is continuous in position, only the heading flips at each turnaround.
// `direction` is which way it's headed initially.
export function positionAtDistance(vehicle: FleetVehicle, distanceMeters: number): RoutePoint {
  const { points, cumulative, totalDistance, direction } = vehicle;
  const period = totalDistance * 2;
  // `distanceMeters` always increases with time — `direction` only shifts
  // where in the ping-pong cycle it starts (a half-period phase offset), it
  // must not flip the sign of an ever-growing value fed into the modulo
  // below (that produced a vehicle whose position kept moving forward while
  // its computed heading said "reversed").
  const offset = direction === 1 ? 0 : totalDistance;
  const m = ((distanceMeters + offset) % period + period) % period;
  const goingForward = m <= totalDistance;
  const d = goingForward ? m : period - m;

  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= d) lo = mid;
    else hi = mid;
  }

  const segStart = cumulative[lo];
  const segLength = cumulative[hi] - segStart || 1;
  const t = (d - segStart) / segLength;

  const a = points[lo];
  const b = points[hi];
  const heading = goingForward ? a.heading : (a.heading + 180) % 360;

  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
    heading,
  };
}
