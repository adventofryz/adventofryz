export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoutePoint extends LatLng {
  heading: number;
}

// A single reported position. `t` is the simulated clock (ms) — the key
// merge.ts dedupes on, standing in for a real API's timestamp field.
export interface TrackPoint extends RoutePoint {
  t: number;
  // Set by merge.ts on the first point after a GPS-loss discontinuity —
  // playback snaps here instead of gliding, and the trail breaks.
  gap?: boolean;
}

export interface VehicleMeta {
  id: string;
  plate: string;
  model: string;
}
