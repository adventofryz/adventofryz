export interface Poi {
  name: string;
  label: string;
  lat: number;
  lng: number;
}

// Static, hand-picked SF landmarks inside the demo's bbox — purely
// illustrative scenery, not wired to the routing/simulation.
export const POIS: Poi[] = [
  { name: 'St. Francis Memorial Hospital', label: 'Hospital', lat: 37.7879, lng: -122.4177 },
  { name: 'Westfield San Francisco Centre', label: 'Mall', lat: 37.7845, lng: -122.4067 },
  { name: 'Moscone Center', label: 'Convention Center', lat: 37.7841, lng: -122.4013 },
  { name: 'San Francisco City Hall', label: 'City Hall', lat: 37.7793, lng: -122.4193 },
  { name: 'SOMA Distribution Depot', label: 'Depot', lat: 37.7749, lng: -122.4038 },
  { name: 'Tenderloin Apartments', label: 'Residence', lat: 37.7838, lng: -122.4144 },
];
