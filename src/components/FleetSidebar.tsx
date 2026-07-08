import type { Fleet, VehicleStatus } from './fleet/types';
import './FleetSidebar.css';

interface FleetSidebarProps {
  fleets: Fleet[];
  statusById: Record<string, VehicleStatus>;
  selectedId: string | null;
  open: boolean;
  onToggle: () => void;
  onSelectVehicle: (id: string) => void;
}

export default function FleetSidebar({ fleets, statusById, selectedId, open, onToggle, onSelectVehicle }: FleetSidebarProps) {
  return (
    <>
      <button
        type="button"
        className={`fleet-sidebar-handle${open ? ' fleet-sidebar-handle-open' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? 'Hide fleets' : 'Show fleets'}
        title={open ? 'Hide fleets' : 'Show fleets'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9,6 15,12 9,18" />
        </svg>
      </button>

      <div className={`fleet-sidebar${open ? ' fleet-sidebar-open' : ''}`}>
        <p className="fleet-sidebar-title">Fleets</p>
        <div className="fleet-sidebar-list">
          {/* Skipped while closed — it's invisible anyway, and at fleet
              sizes in the thousands, reconciling every row on every
              vehicle click (which re-renders this component regardless of
              `open`) is real, avoidable cost. */}
          {open &&
            fleets.map((fleet) => (
              <details key={fleet.id} className="fleet-sidebar-fleet">
                <summary>
                  <svg className="fleet-sidebar-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="9,6 15,12 9,18" />
                  </svg>
                  <span className="fleet-sidebar-fleet-name">{fleet.name}</span>
                  <span className="fleet-sidebar-count">{fleet.vehicleIds.length}</span>
                </summary>
                <ul>
                  {fleet.vehicleIds.map((id) => {
                    const status = statusById[id] ?? 'idle';
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          className={`fleet-sidebar-vehicle${id === selectedId ? ' is-selected' : ''}`}
                          onClick={() => onSelectVehicle(id)}
                        >
                          <i className={`fleet-dot fleet-dot-${status === 'signal-lost' ? 'anomaly' : status}`} />
                          {id}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
        </div>
      </div>
    </>
  );
}
