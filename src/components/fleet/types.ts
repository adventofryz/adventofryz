export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoutePoint extends LatLng {
  heading: number;
}

// A single reported position. `t` is the simulated clock (ms) it was recorded
// at — this is the key the merge step dedupes on, standing in for whatever
// sequence/timestamp field a real tracking API would attach per ping.
export interface TrackPoint extends RoutePoint {
  t: number;
  // Set by the merge step on the first point after a detected GPS-loss
  // discontinuity (e.g. a tunnel/bridge). Playback snaps to this point
  // instead of gliding, and the trail breaks rather than drawing a fake
  // straight line across the gap.
  gap?: boolean;
}

export interface VehicleMeta {
  id: string;
  plate: string;
  model: string;
  job: string;
}
