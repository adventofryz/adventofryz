import type { Fleet } from './types';

// SF-flavored names for illustrative grouping only — there's no real
// operator behind them.
const FLEET_NAMES = ['Downtown Couriers', 'Mission Logistics', 'Embarcadero Freight', 'Presidio Shuttle', 'Bayview Cargo'];

// Ids are assigned per base route in creation order (simulate.ts's
// createFleet), so a contiguous slice is already spatially clustered.
export function buildFleets(vehicleIds: string[]): Fleet[] {
  const perFleet = Math.ceil(vehicleIds.length / FLEET_NAMES.length);

  return FLEET_NAMES.map((name, i) => ({
    id: `fleet-${i}`,
    name,
    vehicleIds: vehicleIds.slice(i * perFleet, (i + 1) * perFleet),
  })).filter((fleet) => fleet.vehicleIds.length > 0);
}
