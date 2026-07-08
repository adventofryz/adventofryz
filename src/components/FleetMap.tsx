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
import { buildFleets } from './fleet/fleets';
import { POIS } from './fleet/pois';
import type { Fleet, TrackPoint, VehicleMeta, VehicleStatus } from './fleet/types';
import FleetSidebar from './FleetSidebar';
import './FleetMap.css';

// [[west, south], [east, north]] — matches the bbox build-fleet-data.mjs used.
const SF_BOUNDS: [[number, number], [number, number]] = [
  [-122.439, 37.768],
  [-122.377, 37.798],
];

// Kept small so individual vehicle behavior stays legible — the pipeline
// scales to thousands, but that just reads as a congested blob.
const TARGET_VEHICLE_COUNT = 100;

// Playback trails the poll clock by just over one interval so there's
// always a real buffered point ahead to interpolate toward — rendering the
// live edge instead freezes between polls, then snaps ("teleporting").
const POLL_INTERVAL_MS = 10000;
const PLAYBACK_DELAY_MS = POLL_INTERVAL_MS + 1000;
const BUFFER_RETENTION_MS = PLAYBACK_DELAY_MS + POLL_INTERVAL_MS + 5000;

// How far back the fading trail reaches behind each vehicle.
const TRAIL_LENGTH_MS = 8000;

// Outlasts a dropped-poll freeze's ~8.5s median hold (measured), so the
// ring doesn't fade before the freeze even resolves.
const ANOMALY_PULSE_DURATION_MS = 9000;
// Staggered concurrent rings read as a continuous sweep, not one blinking ring.
const PULSE_RING_PERIOD_MS = 1400;
const PULSE_RING_COUNT = 3;
const PULSE_MIN_RADIUS_PX = 9;
const PULSE_MAX_RADIUS_PX = 26;

// CARTO's free keyless tiles — the one deliberate exception to "no external
// runtime calls" here, since hand-rolled geometry can't match real
// cartography. Voyager (light) over Dark Matter: no keyless dark+colorful
// tier exists, and vivid beats theme-matched-but-flat.
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
  idle: boolean;
  signalLost: boolean;
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const sidebarRootRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState({ total: 0, moving: 0, idle: 0 });
  const [mergeStats, setMergeStats] = useState({ gaps: 0, drops: 0, outliers: 0 });
  const [selected, setSelected] = useState<Selected | null>(null);
  const [follow, setFollow] = useState(false);
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fleets, setFleets] = useState<Fleet[]>([]);
  const [vehicleStatus, setVehicleStatus] = useState<Record<string, VehicleStatus>>({});

  // Mirror `selected`/`follow` for the render loop and native event
  // listeners below, which run outside React's render cycle and would
  // otherwise only see stale state.
  const selectedIdRef = useRef<string | null>(null);
  const followRef = useRef(false);
  // Set inside setup(); lets the sidebar call selectVehicle without a
  // second copy of its logic.
  const selectVehicleRef = useRef<(id: string) => void>(() => {});
  // Read by statusRefreshTimer below — recomputing status for ~100
  // vehicles every second is wasted work while the roster is closed and
  // invisible, and was competing with click handling on the main thread.
  const sidebarOpenRef = useRef(false);
  const refreshVehicleStatusRef = useRef<() => void>(() => {});

  const clearSelection = () => {
    selectedIdRef.current = null;
    followRef.current = false;
    setSelected(null);
    setFollow(false);
  };

  const toggleFollow = () => {
    if (!selectedIdRef.current) return;
    followRef.current = !followRef.current;
    setFollow(followRef.current);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      wrapRef.current?.requestFullscreen();
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let animationFrame = 0;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let selectionRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let worker: Worker | undefined;

    const map = new maplibregl.Map({
      container,
      style: MAP_STYLE,
      // CARTO's style JSON has no attribution metadata, so it's supplied explicitly.
      attributionControl: { compact: true, customAttribution: '&copy; CARTO, &copy; OpenStreetMap contributors' },
    });

    // A custom button (below) drives fullscreen instead of MapLibre's own
    // FullscreenControl — its icon is a baked-in SVG data URI we can only
    // crudely recolor via CSS filters, not match to the site's palette.
    // MapLibre doesn't auto-resize for a fullscreen change it didn't
    // trigger itself, so that's handled here too.
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === wrapRef.current);
      map.resize();
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    // `originalEvent` is only set for user-driven camera changes — our own
    // jumpTo() calls below don't set it — so this only cancels follow on a
    // real manual pan/zoom.
    map.on('movestart', (e) => {
      if (e.originalEvent && followRef.current) {
        followRef.current = false;
        setFollow(false);
      }
    });

    // Closes on Escape or a click outside the popover/map; a click on the
    // map itself is handled by the deck.gl overlay's onClick below, which
    // knows whether it actually hit a vehicle.
    function handleDocumentClick(e: MouseEvent) {
      if (!selectedIdRef.current) return;
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (sidebarRootRef.current?.contains(target)) return;
      if (container!.contains(target)) return;
      clearSelection();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') clearSelection();
    }
    document.addEventListener('click', handleDocumentClick);
    window.addEventListener('keydown', handleKeyDown);

    map.on('load', () => {
      // Fit on load, not construction — the container may not have its
      // final size yet, which previously fit to a wrong guess. Spinner
      // covers the map until this fires.
      map.fitBounds(SF_BOUNDS, { padding: 12, duration: 0 });
      // Locks zoom-out and pan to the initial fit so you can't pan into
      // blank space outside the road network; zooming in is unrestricted.
      map.setMinZoom(map.getZoom());
      map.setMaxBounds(SF_BOUNDS);
      // Bumped in past the full-bbox fit so trails and GPS-loss jumps stay
      // legible at 100 vehicles; zooming out to the full spread still works.
      map.setZoom(map.getZoom() + 1);
      // Centered on the Union Square/Tenderloin border, not the bbox
      // centroid — its tighter block grid carries more route traffic than
      // SOMA's wide blocks.
      map.setCenter([-122.4095, 37.7815]);

      // Illustrative SF landmarks, added as native MapLibre layers rather
      // than deck.gl's TextLayer so labels render through the same glyph
      // pipeline as the basemap's own labels (deck.gl's SDF text won't
      // match). text-font/colors copied from Voyager's place-label layers.
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

    // MapboxOverlay targets mapbox-gl's IControl type; MapLibre implements
    // the same interface, so this cast is deck.gl's documented MapLibre usage.
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
      // Icons render at 15-20px, too small a target for pixel-exact default
      // picking — pads the hit-test area by 20px regardless of icon size.
      pickingRadius: 20,
      // The IconLayer's own onClick (below) handles picks; this only sees
      // `picked: false` — the map background, including POI dots since
      // those aren't a deck.gl layer — and treats that as "dismiss".
      onClick: (info) => {
        if (!info.picked) clearSelection();
      },
    });
    map.addControl(overlay as unknown as maplibregl.IControl);

    async function setup() {
      // Parsing the ~4MB route file and building the fleet (fleet.worker.ts)
      // runs off the main thread so it doesn't block page scroll/UI on mount.
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
      // Vehicle id -> playback-clock time of the point right before a
      // teleport-sized jump; drives the pulse's on/fade-out window (see the
      // distance check in applyBatch below).
      const anomalies = new Map<string, number>();
      // Updated every frame so click/refresh handlers can check signal
      // status "now", on the same clock buildPulseLayer uses.
      let latestRenderTime = -PLAYBACK_DELAY_MS;

      const renderVehicles: RenderVehicle[] = fleet.map((v) => ({
        id: v.id,
        lat: v.points[0].lat,
        lng: v.points[0].lng,
        heading: v.points[0].heading,
        idle: v.idle,
      }));
      // renderVehicles objects are mutated in place, never replaced, so this
      // lookup stays valid without rebuilding.
      const renderVehicleById = new Map(renderVehicles.map((rv) => [rv.id, rv]));

      // Reused by both click and the throttled refresh below — reading live
      // from `renderVehicleById` is what makes the refresh actually live.
      function computeSelected(id: string): Selected | null {
        const vehicle = fleet.find((v) => v.id === id);
        const meta = metadata.get(id);
        const rv = renderVehicleById.get(id);
        if (!vehicle || !meta || !rv) return null;
        const since = anomalies.get(id);
        const age = since !== undefined ? latestRenderTime - since : Infinity;
        const signalLost = age >= 0 && age <= ANOMALY_PULSE_DURATION_MS;
        return { meta, speedMps: vehicle.speedMps, heading: rv.heading, idle: rv.idle, signalLost };
      }

      function selectVehicle(id: string) {
        selectedIdRef.current = id;
        // Starts unfollowed — otherwise clicking a second vehicle while
        // following the first yanks the camera with no warning.
        followRef.current = false;
        setFollow(false);
        setSelected(computeSelected(id));
        // Popover and sidebar both anchor to the left edge — closing the
        // sidebar on any selection keeps them from ever overlapping.
        sidebarOpenRef.current = false;
        setSidebarOpen(false);
      }

      // Also pans there, since a sidebar click (unlike a map click) has no
      // on-screen position to imply one; easeTo sets no `originalEvent`,
      // so it won't trip the follow-cancel guard above.
      selectVehicleRef.current = (id: string) => {
        selectVehicle(id);
        const rv = renderVehicleById.get(id);
        if (rv) map.easeTo({ center: [rv.lng, rv.lat], duration: 600 });
      };

      const movingCount = fleet.filter((v) => !v.idle).length;
      setStats({ total: fleet.length, moving: movingCount, idle: fleet.length - movingCount });
      setFleets(buildFleets(fleet.map((v) => v.id)));

      const rootStyle = getComputedStyle(document.documentElement);
      const accentHex = rootStyle.getPropertyValue('--accent').trim() || '#2dd4bf';
      const mutedHex = rootStyle.getPropertyValue('--text-muted').trim() || '#8b97a8';
      const warnHex = rootStyle.getPropertyValue('--warn').trim() || '#f59e0b';
      const atlas = buildVehicleIconAtlas(accentHex, mutedHex);
      const accentRgb = hexToRgb(accentHex);
      const mutedRgb = hexToRgb(mutedHex);
      const warnRgb = hexToRgb(warnHex);
      // Fixed, not sourced from the site's CSS vars — those are tuned for
      // the dark site theme, but this ring sits on the Voyager basemap's
      // light map surface, so it needs to contrast against that instead.
      // Not accent/warn either, so it never reads as a vehicle-state color.
      const selectionRgb: [number, number, number] = [37, 99, 235];

      let frameTick = 0;

      // Glow halo keeps vehicles the clear focal point over the colorful basemap.
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

      // Fading rings flag a vehicle with a recent gap event as possibly off
      // its true course. Staggered concurrent rings read as a continuous pulse.
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

      // Static ring around the selected vehicle, distinct from the animated
      // warn-colored anomaly pulse above. A white halo behind the blue ring
      // keeps it visible over the basemap's light-blue water areas too.
      function buildSelectionLayer() {
        const rv = selectedIdRef.current ? renderVehicleById.get(selectedIdRef.current) : undefined;
        if (!rv) return null;
        return [
          new ScatterplotLayer<RenderVehicle>({
            id: 'vehicle-selection-halo',
            data: [rv],
            getPosition: (d) => [d.lng, d.lat],
            getRadius: 17,
            radiusUnits: 'pixels',
            filled: false,
            stroked: true,
            getLineColor: [255, 255, 255, 220],
            getLineWidth: 4,
            lineWidthUnits: 'pixels',
            updateTriggers: {
              getPosition: frameTick,
            },
          }),
          new ScatterplotLayer<RenderVehicle>({
            id: 'vehicle-selection',
            data: [rv],
            getPosition: (d) => [d.lng, d.lat],
            getRadius: 15,
            radiusUnits: 'pixels',
            filled: false,
            stroked: true,
            getLineColor: () => [...selectionRgb, 255],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            updateTriggers: {
              getPosition: frameTick,
            },
          }),
        ];
      }

      // Fed from the same buffers used for playback interpolation. Rebuilt
      // only on each poll, not every frame — TripsLayer handles the fade
      // cheaply by advancing `currentTime` against the same data.
      let tripsData: TripDatum[] = [];

      function rebuildTripsData() {
        tripsData = renderVehicles.flatMap((rv) => {
          const buffer = buffers.get(rv.id) ?? [];

          // Split on `gap` boundaries so the trail breaks at a real
          // GPS-loss jump instead of drawing a straight line across it.
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
          // heading is clockwise-from-north; deck.gl rotates icons
          // counterclockwise, so it's negated here.
          getAngle: (d) => -d.heading,
          getSize: 15,
          sizeUnits: 'pixels',
          sizeMinPixels: 5,
          sizeMaxPixels: 20,
          pickable: true,
          onClick: (info) => {
            if (!info.object) return;
            selectVehicle(info.object.id);
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
          buildSelectionLayer(),
          buildVehicleLayer(),
        ],
      });

      const eventTotals = { gaps: 0, drops: 0, outliers: 0 };
      const tallyEvent: Partial<Record<MergeEvent, keyof typeof eventTotals>> = {
        gap: 'gaps',
        empty: 'drops',
        outlier: 'outliers',
      };

      // `trackStats` is false only for the startup seed batch — it uses the
      // same failure logic for plausibility, but represents invisible
      // pre-mount history, so counting it would start the stat cards at a
      // nonzero number with no visible activity to explain it.
      function applyBatch(batch: Map<string, TrackPoint[]>, cursorT: number, trackStats: boolean) {
        for (const [id, incoming] of batch) {
          const previous = buffers.get(id) ?? [];
          const { buffer: merged, events } = mergeTrackingPath(previous, incoming);
          buffers.set(id, trimBuffer(merged, cursorT, BUFFER_RETENTION_MS));

          // Scans only the newly-appended range — older pairs were already
          // checked when they first appeared. Keyed off merge.ts's own
          // `gap` flag (the same one playback.ts snaps on), not a separate
          // distance check — a raw haversine threshold on its own also
          // flags the merely-longer-than-usual (but still smooth) segment
          // after an ordinary dropped poll, which isn't a real relocation.
          for (let i = Math.max(previous.length - 1, 0); i < merged.length - 1; i++) {
            if (merged[i + 1].gap) {
              // Anchored to the point *before* the jump — interpolateAt
              // holds the vehicle there until playback catches up, so
              // that's when the freeze actually starts on screen (using
              // `cursorT` instead would be ~PLAYBACK_DELAY_MS early).
              anomalies.set(id, merged[i].t);
            }
          }
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

      // Seeds each buffer with a window ending at t=0 (negative timestamps
      // are valid on a looping route) so playback has data from frame one.
      applyBatch(pollFleet(fleet, -PLAYBACK_DELAY_MS, 0), 0, false);

      const startTime = performance.now();
      let lastPollT = 0;

      function poll() {
        const nowT = performance.now() - startTime;
        applyBatch(pollFleet(fleet, lastPollT, nowT), nowT, true);
        lastPollT = nowT;
      }

      pollTimer = setInterval(poll, POLL_INTERVAL_MS);

      // Keeps the popover's heading/status fields live while the vehicle
      // moves, without re-rendering React on every animation frame.
      selectionRefreshTimer = setInterval(() => {
        const id = selectedIdRef.current;
        if (id) setSelected(computeSelected(id));
      }, 300);

      // Drives the sidebar's status dots — coarser than the selection
      // refresh above since the roster doesn't need render-loop precision.
      function refreshVehicleStatus() {
        const next: Record<string, VehicleStatus> = {};
        for (const rv of renderVehicles) {
          const since = anomalies.get(rv.id);
          const age = since !== undefined ? latestRenderTime - since : Infinity;
          next[rv.id] = age >= 0 && age <= ANOMALY_PULSE_DURATION_MS ? 'signal-lost' : rv.idle ? 'idle' : 'moving';
        }
        setVehicleStatus(next);
      }
      refreshVehicleStatusRef.current = refreshVehicleStatus;
      statusRefreshTimer = setInterval(() => {
        if (sidebarOpenRef.current) refreshVehicleStatus();
      }, 1000);

      function frame() {
        const realNowT = performance.now() - startTime;
        const renderTime = realNowT - PLAYBACK_DELAY_MS;
        latestRenderTime = renderTime;

        for (const rv of renderVehicles) {
          const buffer = buffers.get(rv.id);
          const pos = buffer ? interpolateAt(buffer, renderTime) : null;
          if (pos) {
            rv.lat = pos.lat;
            rv.lng = pos.lng;
            rv.heading = pos.heading;
          }
        }

        if (followRef.current && selectedIdRef.current) {
          const rv = renderVehicleById.get(selectedIdRef.current);
          // jumpTo, not easeTo — position is already smoothly interpolated
          // above, so an eased camera would add a second competing curve.
          if (rv) map.jumpTo({ center: [rv.lng, rv.lat] });
        }

        frameTick++;
        overlay.setProps({
          layers: [
            buildTrailLayer(renderTime),
            buildVehicleGlowLayer(),
            buildPulseLayer(renderTime),
            buildSelectionLayer(),
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
      if (selectionRefreshTimer) clearInterval(selectionRefreshTimer);
      if (statusRefreshTimer) clearInterval(statusRefreshTimer);
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener('keydown', handleKeyDown);
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
        <Stat
          label="Gaps bridged"
          value={mergeStats.gaps}
          tone="idle"
          hint="The car reported a real jump to a new location and stayed there — accepted as a genuine move, not a glitch."
        />
        <Stat
          label="Drops"
          value={mergeStats.drops}
          tone="idle"
          hint="The car missed a check-in. Instead of guessing, we hold its last known position until it reports again."
        />
        <Stat
          label="Spikes rejected"
          value={mergeStats.outliers}
          tone="idle"
          hint="One bad reading flickered off-course, then immediately corrected itself — we filter it out instead of trusting it."
        />
      </div>

      <div className="fleet-map-wrap" ref={wrapRef}>
        <div ref={containerRef} className="fleet-map" />

        {/* Excluded from handleDocumentClick's outside-click check below,
            or selecting a vehicle here would immediately clear itself. */}
        <div ref={sidebarRootRef}>
          <FleetSidebar
            fleets={fleets}
            statusById={vehicleStatus}
            selectedId={selected?.meta.id ?? null}
            open={sidebarOpen}
            onToggle={() => {
              const next = !sidebarOpen;
              sidebarOpenRef.current = next;
              setSidebarOpen(next);
              // Otherwise the dots would show up to a second-old data on open.
              if (next) refreshVehicleStatusRef.current();
            }}
            onSelectVehicle={(id) => selectVehicleRef.current(id)}
          />
        </div>

        {!ready && (
          <div className="fleet-map-loading">
            <span className="fleet-spinner" />
            Loading map&hellip;
          </div>
        )}

        {isFullscreen && (
          <div className="fleet-merge-overlay">
            <span title="The car reported a real jump to a new location and stayed there — accepted as a genuine move, not a glitch.">
              <strong>{mergeStats.gaps}</strong> gaps bridged
            </span>
            <span title="The car missed a check-in. Instead of guessing, we hold its last known position until it reports again.">
              <strong>{mergeStats.drops}</strong> drops
            </span>
            <span title="One bad reading flickered off-course, then immediately corrected itself — we filter it out instead of trusting it.">
              <strong>{mergeStats.outliers}</strong> spikes rejected
            </span>
          </div>
        )}

        <div className="fleet-overlay-stack fleet-overlay-stack-top-right">
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

          <button
            type="button"
            className="fleet-fullscreen-toggle"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9,3 9,9 3,9" />
                <polyline points="15,3 15,9 21,9" />
                <polyline points="3,15 9,15 9,21" />
                <polyline points="21,15 15,15 15,21" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9,3 3,3 3,9" />
                <polyline points="15,3 21,3 21,9" />
                <polyline points="3,15 3,21 9,21" />
                <polyline points="21,15 21,21 15,21" />
              </svg>
            )}
          </button>
        </div>

        {selected && (
          <div className="fleet-popover" ref={popoverRef}>
            <div className="fleet-popover-header">
              <p className="fleet-popover-title">{selected.meta.id}</p>
              <button type="button" className="fleet-popover-close" onClick={clearSelection} aria-label="Close">
                &times;
              </button>
            </div>
            <p className={`fleet-popover-status${selected.signalLost ? ' fleet-popover-status-alert' : ''}`}>
              {selected.signalLost ? 'Signal lost — relocating' : selected.idle ? 'Idle' : 'Moving'}
            </p>
            <p>
              <span>Plate</span>
              <span>{selected.meta.plate}</span>
            </p>
            <p>
              <span>Model</span>
              <span>{selected.meta.model}</span>
            </p>
            <p>
              <span>Speed</span>
              <span>{Math.round(selected.speedMps * 3.6)} km/h</span>
            </p>
            <p>
              <span>Heading</span>
              <span>{Math.round(selected.heading)}&deg;</span>
            </p>
            <button
              type="button"
              className={`fleet-popover-follow${follow ? ' fleet-popover-follow-active' : ''}`}
              onClick={toggleFollow}
            >
              {follow ? 'Following' : 'Follow'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: number; tone?: 'moving' | 'idle'; hint?: string }) {
  return (
    <div className={`fleet-stat${hint ? ' fleet-stat-has-hint' : ''}`} tabIndex={hint ? 0 : undefined}>
      <span className={`fleet-stat-value${tone ? ` fleet-stat-${tone}` : ''}`}>{value.toLocaleString()}</span>
      <span className="fleet-stat-label">
        {label}
        {hint && (
          <svg className="fleet-stat-hint-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="4.6" r="1" fill="currentColor" />
            <line x1="8" y1="7.2" x2="8" y2="11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        )}
      </span>
      {hint && (
        <span className="fleet-stat-tooltip" role="tooltip">
          {hint}
        </span>
      )}
    </div>
  );
}
