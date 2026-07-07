import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { FleetVehicle } from './fleet/simulate';
import { pollFleet } from './fleet/poller';
import { mergeTrackingPath, trimBuffer, type MergeEvent } from './fleet/merge';
import { interpolateAt } from './fleet/playback';
import { buildVehicleIconAtlas } from './fleet/icons';
import { POIS } from './fleet/pois';
import type { TrackPoint, VehicleMeta } from './fleet/types';
import './FleetMap.css';

// Same bbox scripts/build-fleet-data.mjs generated the road/route data from —
// [[west, south], [east, north]].
const SF_BOUNDS: [[number, number], [number, number]] = [
  [-122.439, 37.768],
  [-122.377, 37.798],
];

// Small enough that individual vehicle behavior (a jump, a pause, a rejected
// spike) reads clearly on the map — the system underneath is built to handle
// thousands, but showing 5,000 of them just reads as a congested blob.
const TARGET_VEHICLE_COUNT = 100;

// The real system delivers a new trackingPath roughly every 10s. Rendering is
// intentionally delayed behind that by a bit more than one poll interval, so
// playback always has two real buffered points to interpolate between —
// never the live edge. Without this, the render clock races ahead of the
// buffer between polls, freezes at the last known point, then snaps forward
// once the next batch arrives (the "teleporting" bug).
const POLL_INTERVAL_MS = 10000;
const PLAYBACK_DELAY_MS = POLL_INTERVAL_MS + 1000;
const BUFFER_RETENTION_MS = PLAYBACK_DELAY_MS + POLL_INTERVAL_MS + 5000;

// How far back the fading trail reaches behind each vehicle.
const TRAIL_LENGTH_MS = 8000;

// How long a vehicle keeps showing the alert pulse after its data becomes
// untrustworthy (a GPS-loss `gap`, or a dropped-poll freeze — see
// `droppedLastBatch` below). Sized to the *drop* case's ~8.5s median hold
// (empirically measured), not the shorter ~4.25s gap-hold — the reverse
// would mean the ring routinely fades out before the more common drop case
// ever resolves. Still short enough not to linger once reporting is normal.
const ANOMALY_PULSE_DURATION_MS = 9000;
// Concurrent staggered rings (rather than one ring resetting) so the pulse
// reads as a continuous radar sweep instead of a single blink-and-restart.
const PULSE_RING_PERIOD_MS = 1400;
const PULSE_RING_COUNT = 3;
const PULSE_MIN_RADIUS_PX = 9;
const PULSE_MAX_RADIUS_PX = 26;

// A real cartographic basemap (roads, native labels) instead of hand-drawn
// line geometry — CARTO's free, keyless styles. This is a deliberate
// exception to the site's "no external runtime calls" rule: the
// vehicle/route simulation stays fully self-hosted, but a hand-rolled
// GeoJsonLayer + deck.gl TextLayer will never match real map-tile cartography
// (proper label placement, road styling, hinted typography), so the basemap
// visuals are the one thing pulled from a live tile service. Dark Matter
// (grayscale) read as flat/lifeless — there's no keyless colorful *dark*
// style available (that tier needs a MapTiler/Stadia API key), so Voyager
// (colorful, light) trades theme-matching for an actually vivid, alive map.
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

interface RenderVehicle {
  id: string;
  lat: number;
  lng: number;
  heading: number;
  idle: boolean;
}

interface Selected {
  meta: VehicleMeta;
  speedMps: number;
  heading: number;
}

interface TripDatum {
  id: string;
  path: [number, number][];
  timestamps: number[];
  idle: boolean;
}

interface PulseRingDatum {
  id: string;
  lat: number;
  lng: number;
  radius: number;
  opacity: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const num = parseInt(hex.replace('#', ''), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export default function FleetMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState({ total: 0, moving: 0, idle: 0 });
  const [mergeStats, setMergeStats] = useState({ gaps: 0, drops: 0, outliers: 0 });
  const [selected, setSelected] = useState<Selected | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let animationFrame = 0;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let worker: Worker | undefined;

    const map = new maplibregl.Map({
      container,
      style: MAP_STYLE,
      // CARTO's style JSON doesn't embed attribution metadata on its source,
      // so it has to be supplied explicitly rather than relying on MapLibre
      // picking it up automatically.
      attributionControl: { compact: true, customAttribution: '&copy; CARTO, &copy; OpenStreetMap contributors' },
    });

    map.on('load', () => {
      // Fit bounds here rather than at construction time — the container's
      // CSS aspect-ratio box may not have its final size yet when the map
      // is constructed, which previously caused it to fit to a wrong
      // guessed size (roads rendering as a small centered island instead
      // of filling the view). The loading spinner covers the map until this
      // fires, so nobody sees that wrong fit either.
      map.fitBounds(SF_BOUNDS, { padding: 12, duration: 0 });
      // Lock how far out you can zoom (to the initial fit) and how far you
      // can pan, so there's no way to end up staring at blank space outside
      // the road network — zooming in further is still unrestricted.
      map.setMinZoom(map.getZoom());
      map.setMaxBounds(SF_BOUNDS);
      // The default view zooms in past that full-bbox fit — at 100 vehicles
      // there's no density/blob problem left, but the fading trails (a few
      // dozen meters long) and the occasional GPS-loss jump are still too
      // small to read at the full-bbox scale. A modest bump keeps individual
      // paths legible; zooming out to see the full spread (up to the minZoom
      // lock above) is still available.
      map.setZoom(map.getZoom() + 1);
      // Route-point density (sampled from sf-routes.json) peaks around the
      // Union Square/Tenderloin border, not the bbox centroid — routes are
      // drawn from the OSM node graph, and that area's tighter block grid
      // has more nodes/intersections than SOMA's wide blocks, so more
      // vehicles end up passing through this frame at any given time.
      map.setCenter([-122.4095, 37.7815]);

      // Static scenery — a handful of real SF landmarks, purely illustrative,
      // giving the map a "somewhere with a purpose" feel. Added as native
      // MapLibre source/layers rather than deck.gl's TextLayer: MapLibre's
      // own labels (the ones that already look crisp) render through its
      // real glyph-font pipeline, and deck.gl's separate SDF bitmap-font
      // renderer will never quite match that — using the same pipeline the
      // basemap's own labels use is what actually produces matching quality,
      // not more fontSettings tuning. text-font/colors below are copied from
      // Voyager's own place-label layers (style.json) for consistency.
      map.addSource('pois', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: POIS.map((p) => ({
            type: 'Feature',
            properties: { label: p.label },
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          })),
        },
      });

      map.addLayer({
        id: 'poi-dots',
        type: 'circle',
        source: 'pois',
        paint: {
          'circle-radius': 5,
          'circle-color': '#405c78',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#f2f5f8',
        },
      });

      map.addLayer({
        id: 'poi-labels',
        type: 'symbol',
        source: 'pois',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular', 'Noto Sans Regular'],
          'text-size': 12,
          'text-offset': [0, -1.4],
          'text-anchor': 'bottom',
        },
        paint: {
          'text-color': '#405c78',
          'text-halo-color': '#f2f5f8',
          'text-halo-width': 1,
        },
      });

      setReady(true);
    });

    // MapboxOverlay's types target mapbox-gl's IControl; MapLibre implements
    // the same control interface, so this cast is the documented way to use
    // deck.gl's MapLibre integration.
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    });
    map.addControl(overlay as unknown as maplibregl.IControl);

    async function setup() {
      // Fetching + parsing the ~4MB route file and building 5,000 vehicles
      // (fleet.worker.ts) runs off the main thread — this was blocking work
      // happening right as the demo mounted, competing with page scroll/UI.
      worker = new Worker(new URL('./fleet/fleet.worker.ts', import.meta.url), { type: 'module' });

      const { fleet, metadata } = await new Promise<{
        fleet: FleetVehicle[];
        metadata: Map<string, VehicleMeta>;
      }>((resolve, reject) => {
        worker!.onmessage = (e: MessageEvent<{ fleet: FleetVehicle[]; metadata: [string, VehicleMeta][] }>) => {
          resolve({ fleet: e.data.fleet, metadata: new Map(e.data.metadata) });
        };
        worker!.onerror = reject;
        worker!.postMessage({ targetCount: TARGET_VEHICLE_COUNT });
      });

      worker.terminate();
      worker = undefined;

      if (cancelled) return;

      const buffers = new Map<string, TrackPoint[]>();
      // Vehicle id -> the playback-clock time (a TrackPoint `t`, same clock
      // `renderTime` advances on) its most recent gap event started freezing
      // it at — drives the alert pulse's on/fade-out window.
      const anomalies = new Map<string, number>();
      // Vehicle id -> whether *last* poll's batch for it produced a gap event.
      // poller.ts's GPS-loss offset is corrected on the following poll, which
      // merge.ts also sees as an implausible-speed jump and flags `gap` —
      // that correction is real (see poller.ts's own comment on it) but its
      // hold is a single sample interval (~250ms, imperceptible), unlike the
      // original glitch's multi-second freeze. Pulsing on it too just looks
      // like the ring fired for no reason, since there's no visible stop to
      // anchor it to — so it's excluded from anomalies below.
      const glitchedLastBatch = new Map<string, boolean>();
      // Vehicle id -> whether its *last* poll came back empty (DROP_CHANCE —
      // a missed packet, merge.ts's `empty` event). While a vehicle is in
      // this state, interpolateAt has nothing newer to interpolate toward,
      // so it holds at its last point for up to a full poll interval; once
      // data resumes, playback bridges the gap with a straight line to
      // wherever the vehicle actually got to, not the road it actually took.
      // That reads as the same kind of "this position is a guess, not real
      // telemetry" moment as a GPS-loss `gap` (often with a longer hold), but
      // merge.ts never flags it, so without this it never triggers a pulse.
      const droppedLastBatch = new Map<string, boolean>();

      const renderVehicles: RenderVehicle[] = fleet.map((v) => ({
        id: v.id,
        lat: v.points[0].lat,
        lng: v.points[0].lng,
        heading: v.points[0].heading,
        idle: v.idle,
      }));
      // renderVehicles' objects are mutated in place each frame (see below),
      // never replaced, so this lookup stays valid without rebuilding.
      const renderVehicleById = new Map(renderVehicles.map((rv) => [rv.id, rv]));

      const movingCount = fleet.filter((v) => !v.idle).length;
      setStats({ total: fleet.length, moving: movingCount, idle: fleet.length - movingCount });

      const rootStyle = getComputedStyle(document.documentElement);
      const accentHex = rootStyle.getPropertyValue('--accent').trim() || '#2dd4bf';
      const mutedHex = rootStyle.getPropertyValue('--text-muted').trim() || '#8b97a8';
      const warnHex = rootStyle.getPropertyValue('--warn').trim() || '#f59e0b';
      const atlas = buildVehicleIconAtlas(accentHex, mutedHex);
      const accentRgb = hexToRgb(accentHex);
      const mutedRgb = hexToRgb(mutedHex);
      const warnRgb = hexToRgb(warnHex);

      let frameTick = 0;

      // A soft glow halo behind each icon, plus a larger icon size, keeps the
      // vehicles — the actual point of the demo — as the clear focal point
      // regardless of whatever colorful detail the basemap renders underneath.
      function buildVehicleGlowLayer() {
        return new ScatterplotLayer<RenderVehicle>({
          id: 'vehicle-glow',
          data: renderVehicles,
          getPosition: (d) => [d.lng, d.lat],
          getFillColor: (d) => (d.idle ? [...mutedRgb, 60] : [...accentRgb, 80]),
          getRadius: 9,
          radiusUnits: 'pixels',
          updateTriggers: {
            getPosition: frameTick,
          },
        });
      }

      // Expanding, fading rings around any vehicle with a recent gap event —
      // the visual flag for "this one's reporting bad/malformed data and may
      // be off its true course". Several staggered rings per vehicle run
      // concurrently so it reads as a continuous pulse rather than a single
      // one-shot blink.
      function buildPulseLayer(renderTime: number) {
        const data: PulseRingDatum[] = [];
        for (const [id, since] of anomalies) {
          const age = renderTime - since;
          if (age < 0 || age > ANOMALY_PULSE_DURATION_MS) continue;
          const rv = renderVehicleById.get(id);
          if (!rv) continue;

          for (let ring = 0; ring < PULSE_RING_COUNT; ring++) {
            const ringOffset = (ring * PULSE_RING_PERIOD_MS) / PULSE_RING_COUNT;
            const phase = ((age + ringOffset) % PULSE_RING_PERIOD_MS) / PULSE_RING_PERIOD_MS;
            data.push({
              id: `${id}#${ring}`,
              lat: rv.lat,
              lng: rv.lng,
              radius: PULSE_MIN_RADIUS_PX + phase * (PULSE_MAX_RADIUS_PX - PULSE_MIN_RADIUS_PX),
              opacity: (1 - phase) * 220,
            });
          }
        }

        return new ScatterplotLayer<PulseRingDatum>({
          id: 'anomaly-pulse',
          data,
          getPosition: (d) => [d.lng, d.lat],
          getRadius: (d) => d.radius,
          radiusUnits: 'pixels',
          filled: false,
          stroked: true,
          getLineColor: (d) => [...warnRgb, d.opacity],
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
          updateTriggers: {
            getPosition: frameTick,
            getRadius: frameTick,
            getLineColor: frameTick,
          },
        });
      }

      // Fed from the same per-vehicle position buffers used for playback
      // interpolation — no separate trail-tracking needed. Rebuilt only when
      // a buffer actually changes (each poll), not every frame; TripsLayer
      // handles the fade purely by moving `currentTime` forward each frame
      // against the same path/timestamps data, which is the cheap part.
      let tripsData: TripDatum[] = [];

      function rebuildTripsData() {
        tripsData = renderVehicles.flatMap((rv) => {
          const buffer = buffers.get(rv.id) ?? [];

          // Split on `gap` boundaries — a GPS-loss jump is a real
          // discontinuity, so the trail must break there rather than
          // TripsLayer drawing a fake straight line across it.
          const segments: TrackPoint[][] = [];
          let current: TrackPoint[] = [];
          for (const p of buffer) {
            if (p.gap && current.length > 0) {
              segments.push(current);
              current = [];
            }
            current.push(p);
          }
          if (current.length > 0) segments.push(current);

          return segments.map(
            (segment, i): TripDatum => ({
              id: `${rv.id}#${i}`,
              path: segment.map((p): [number, number] => [p.lng, p.lat]),
              timestamps: segment.map((p) => p.t),
              idle: rv.idle,
            }),
          );
        });
      }

      function buildTrailLayer(currentTime: number) {
        return new TripsLayer<TripDatum>({
          id: 'vehicle-trails',
          data: tripsData,
          getPath: (d) => d.path,
          getTimestamps: (d) => d.timestamps,
          getColor: (d) => (d.idle ? mutedRgb : accentRgb),
          opacity: 0.6,
          widthMinPixels: 2,
          capRounded: true,
          jointRounded: true,
          trailLength: TRAIL_LENGTH_MS,
          currentTime,
        });
      }

      function buildVehicleLayer() {
        return new IconLayer<RenderVehicle>({
          id: 'vehicles',
          data: renderVehicles,
          iconAtlas: atlas.image,
          iconMapping: atlas.mapping,
          getIcon: (d) => (d.idle ? 'idle' : 'moving'),
          getPosition: (d) => [d.lng, d.lat],
          // heading is a compass bearing (clockwise from north); deck.gl
          // rotates IconLayer icons counterclockwise for positive angles, so
          // it has to be negated to point the icon the right way.
          getAngle: (d) => -d.heading,
          getSize: 15,
          sizeUnits: 'pixels',
          sizeMinPixels: 5,
          sizeMaxPixels: 20,
          pickable: true,
          onClick: (info) => {
            if (!info.object) return;
            const vehicle = fleet.find((v) => v.id === info.object!.id);
            const meta = metadata.get(info.object.id);
            if (vehicle && meta) {
              setSelected({ meta, speedMps: vehicle.speedMps, heading: info.object.heading });
            }
          },
          updateTriggers: {
            getPosition: frameTick,
            getAngle: frameTick,
          },
        });
      }

      overlay.setProps({
        layers: [
          buildTrailLayer(-PLAYBACK_DELAY_MS),
          buildVehicleGlowLayer(),
          buildPulseLayer(-PLAYBACK_DELAY_MS),
          buildVehicleLayer(),
        ],
      });

      const eventTotals = { gaps: 0, drops: 0, outliers: 0 };
      const tallyEvent: Partial<Record<MergeEvent, keyof typeof eventTotals>> = {
        gap: 'gaps',
        empty: 'drops',
        outlier: 'outliers',
      };

      // `trackStats` is false only for the startup seed batch below — it
      // runs through the same random-failure logic as a real poll (so the
      // seeded buffer/pulses look plausible), but it represents invisible
      // pre-mount history, not anything the viewer actually watched happen.
      // Counting it would make the stat cards start at some nonzero number
      // the instant the page loads, with no visible poll or map activity to
      // explain it.
      function applyBatch(batch: Map<string, TrackPoint[]>, cursorT: number, trackStats: boolean) {
        for (const [id, incoming] of batch) {
          const previous = buffers.get(id) ?? [];
          const { buffer: merged, events } = mergeTrackingPath(previous, incoming);
          buffers.set(id, trimBuffer(merged, cursorT, BUFFER_RETENTION_MS));

          const isFreshGap = events.includes('gap') && !glitchedLastBatch.get(id);
          const isDropRecovery = droppedLastBatch.get(id) === true && !events.includes('empty');
          if ((isFreshGap || isDropRecovery) && previous.length > 0) {
            // Anchor the pulse to the *last known-good* point (`previous`'s
            // tail), not the point where the discontinuity is finally
            // resolved — interpolateAt (playback.ts) holds the vehicle right
            // there the instant it can't trust what comes next, so this is
            // when the vehicle actually freezes on screen. Keying off this
            // timestamp (rather than `cursorT`, when merge detected it
            // server-side ~PLAYBACK_DELAY_MS early, or the resolving point,
            // which only fires once playback catches up) makes the ring
            // appear right as the freeze starts, stay lit through the
            // resolution, and fade out shortly after — spanning the whole
            // "this vehicle's data is bad" window instead of only flashing
            // at the tail end of it.
            anomalies.set(id, previous[previous.length - 1].t);
          }
          glitchedLastBatch.set(id, events.includes('gap'));
          droppedLastBatch.set(id, events.includes('empty'));
          if (trackStats) {
            for (const event of events) {
              const key = tallyEvent[event];
              if (key) eventTotals[key]++;
            }
          }
        }
        rebuildTripsData();
        if (trackStats) setMergeStats({ ...eventTotals });
      }

      // Seed each vehicle's buffer with a window ending at t=0 (using
      // negative timestamps — a valid position on a looping route) so
      // playback has real data to interpolate through from frame one,
      // instead of freezing for the first PLAYBACK_DELAY_MS.
      applyBatch(pollFleet(fleet, -PLAYBACK_DELAY_MS, 0), 0, false);

      const startTime = performance.now();
      let lastPollT = 0;

      function poll() {
        const nowT = performance.now() - startTime;
        applyBatch(pollFleet(fleet, lastPollT, nowT), nowT, true);
        lastPollT = nowT;
      }

      pollTimer = setInterval(poll, POLL_INTERVAL_MS);

      function frame() {
        const realNowT = performance.now() - startTime;
        const renderTime = realNowT - PLAYBACK_DELAY_MS;

        for (const rv of renderVehicles) {
          const buffer = buffers.get(rv.id);
          const pos = buffer ? interpolateAt(buffer, renderTime) : null;
          if (pos) {
            rv.lat = pos.lat;
            rv.lng = pos.lng;
            rv.heading = pos.heading;
          }
        }

        frameTick++;
        overlay.setProps({
          layers: [
            buildTrailLayer(renderTime),
            buildVehicleGlowLayer(),
            buildPulseLayer(renderTime),
            buildVehicleLayer(),
          ],
        });
        animationFrame = requestAnimationFrame(frame);
      }

      animationFrame = requestAnimationFrame(frame);
    }

    setup();

    return () => {
      cancelled = true;
      worker?.terminate();
      if (pollTimer) clearInterval(pollTimer);
      cancelAnimationFrame(animationFrame);
      map.remove();
    };
  }, []);

  return (
    <div className="fleet-demo">
      <div className="fleet-stats">
        <Stat label="Total" value={stats.total} />
        <Stat label="Moving" value={stats.moving} tone="moving" />
        <Stat label="Idle" value={stats.idle} tone="idle" />
        <Stat label="Gaps bridged" value={mergeStats.gaps} tone="idle" />
        <Stat label="Drops" value={mergeStats.drops} tone="idle" />
        <Stat label="Spikes rejected" value={mergeStats.outliers} tone="idle" />
      </div>

      <div className="fleet-map-wrap">
        <span className="fleet-badge">Live demo</span>
        <div ref={containerRef} className="fleet-map" />

        {!ready && (
          <div className="fleet-map-loading">
            <span className="fleet-spinner" />
            Loading map&hellip;
          </div>
        )}

        <div className="fleet-legend">
          <span>
            <i className="fleet-dot fleet-dot-moving" />
            Moving
          </span>
          <span>
            <i className="fleet-dot fleet-dot-idle" />
            Idle
          </span>
          <span>
            <i className="fleet-dot fleet-dot-anomaly" />
            Signal loss
          </span>
        </div>

        {selected && (
          <div className="fleet-popover">
            <p className="fleet-popover-title">{selected.meta.id}</p>
            <p className="fleet-popover-job">{selected.meta.job}</p>
            <p>
              <span>Plate</span>
              <span>{selected.meta.plate}</span>
            </p>
            <p>
              <span>Speed</span>
              <span>{Math.round(selected.speedMps * 2.237)} mph</span>
            </p>
            <p>
              <span>Heading</span>
              <span>{Math.round(selected.heading)}&deg;</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'moving' | 'idle' }) {
  return (
    <div className="fleet-stat">
      <span className={`fleet-stat-value${tone ? ` fleet-stat-${tone}` : ''}`}>{value.toLocaleString()}</span>
      <span className="fleet-stat-label">{label}</span>
    </div>
  );
}
