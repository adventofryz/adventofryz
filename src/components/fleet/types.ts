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
}

export interface VehicleMeta {
  id: string;
  plate: string;
  model: string;
  job: string;
}
