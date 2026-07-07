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
  // A small subset of vehicles with a persistently bad connection (old
  // hardware, poor antenna placement) — see poller.ts's elevated failure
  // rates. Concentrating failures onto a few vehicles reads as "these
  // particular cars have a problem" rather than the whole fleet being
  // unreliable.
  flaky: boolean;
}

const IDLE_RATIO = 0.15;
const FLAKY_RATIO = 0.05;
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
    // Computed once per base route, not per clone — jitter is a uniform
    // translation that leaves segment distances unchanged, so recomputing
    // per clone was ~17x redundant work (and the main cause of slow load).
    const baseCumulative = buildCumulative(route);
    const totalDistance = baseCumulative[baseCumulative.length - 1] || 1;

    for (let clone = 0; clone < clonesPerRoute; clone++) {
      if (fleet.length >= targetCount) break outer;

      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * JITTER_RADIUS_M;
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;

      const points = route.map((p) => ({ ...offsetMeters(p, dx, dy), heading: p.heading }));
      const idle = Math.random() < IDLE_RATIO;

      fleet.push({
        id: `VH-${(id++).toString().padStart(4, '0')}`,
        points,
        cumulative: baseCumulative,
        totalDistance,
        speedMps: MIN_SPEED_MPS + Math.random() * (MAX_SPEED_MPS - MIN_SPEED_MPS),
        startOffsetMeters: Math.random() * totalDistance,
        direction: Math.random() < 0.5 ? 1 : -1,
        idle,
        // Idle vehicles never poll for failures (see poller.ts), so being
        // flaky as well as idle would just do nothing.
        flaky: !idle && Math.random() < FLAKY_RATIO,
      });
    }
  }

  return fleet;
}

// Position + heading at a given distance along the route. Wrapping back to
// the start would teleport (start/end aren't near each other), so this
// reflects instead — a continuous ping-pong U-turn, heading flips at each
// turnaround. `direction` is the initial heading.
export function positionAtDistance(vehicle: FleetVehicle, distanceMeters: number): RoutePoint {
  const { points, cumulative, totalDistance, direction } = vehicle;
  const period = totalDistance * 2;
  // `direction` only phase-shifts where the ping-pong cycle starts — it
  // must not flip the sign of the ever-growing `distanceMeters` fed into
  // the modulo below (that bug moved the vehicle forward while its heading
  // said "reversed").
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
