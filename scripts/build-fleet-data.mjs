// One-time data prep: fetches SF's street network from OpenStreetMap
// (Overpass API) and generates vehicle routes along it. Output is
// committed; the running site never calls Overpass (the basemap tiles are
// a separate, deliberate exception — see PLAN.md).

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// south, west, north, east — SF downtown core, widened ~1.5x linear so
// 5,000 vehicles have room to spread out. Sized to match the map
// container's 680:420 aspect ratio so fitBounds fills edge to edge.
const BBOX = [37.768, -122.439, 37.798, -122.377];
const HIGHWAY_TYPES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];
// Scaled up alongside the bbox to keep route density per unit area the same.
const ROUTE_COUNT = 700;
const MIN_ROUTE_POINTS = 8;
const OUT_DIR = path.join(process.cwd(), 'public', 'data');

function buildQuery([south, west, north, east]) {
  const filter = HIGHWAY_TYPES.join('|');
  return `[out:json][timeout:60];way[highway~"^(${filter})$"](${south},${west},${north},${east});out geom;`;
}

async function fetchOverpass() {
  const query = buildQuery(BBOX);
  let lastError;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Fetching from ${endpoint} (attempt ${attempt})...`);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'adventofryz-portfolio-build/1.0 (one-time data fetch)',
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!res.ok) throw new Error(`responded ${res.status}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        console.warn(`  failed: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  throw new Error(`All Overpass endpoints failed: ${lastError.message}`);
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function addEdge(adjacency, from, to, dist) {
  if (!adjacency.has(from)) adjacency.set(from, []);
  adjacency.get(from).push({ to, dist });
}

function toGraph(osm) {
  const nodePos = new Map(); // node id -> {lat, lng}
  const adjacency = new Map(); // node id -> [{ to, dist }]

  for (const way of osm.elements) {
    if (way.type !== 'way' || !way.geometry || way.geometry.length < 2) continue;

    const coords = way.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));

    for (let i = 0; i < way.nodes.length; i++) {
      nodePos.set(way.nodes[i], coords[i]);
    }

    for (let i = 0; i < way.nodes.length - 1; i++) {
      const dist = haversine(coords[i], coords[i + 1]);
      addEdge(adjacency, way.nodes[i], way.nodes[i + 1], dist);
      addEdge(adjacency, way.nodes[i + 1], way.nodes[i], dist);
    }
  }

  return { nodePos, adjacency };
}

// Small binary min-heap, keyed by `dist` — Dijkstra over a few thousand nodes
// needs better than O(V^2) per query since we run it ~300 times.
class MinHeap {
  #items = [];

  get size() {
    return this.#items.length;
  }

  push(item) {
    this.#items.push(item);
    let i = this.#items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#items[parent].dist <= this.#items[i].dist) break;
      [this.#items[parent], this.#items[i]] = [this.#items[i], this.#items[parent]];
      i = parent;
    }
  }

  pop() {
    const top = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length > 0) {
      this.#items[0] = last;
      let i = 0;
      const n = this.#items.length;
      while (true) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        if (left < n && this.#items[left].dist < this.#items[smallest].dist) smallest = left;
        if (right < n && this.#items[right].dist < this.#items[smallest].dist) smallest = right;
        if (smallest === i) break;
        [this.#items[smallest], this.#items[i]] = [this.#items[i], this.#items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function dijkstra(adjacency, start) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const visited = new Set();
  const heap = new MinHeap();
  heap.push({ id: start, dist: 0 });

  while (heap.size > 0) {
    const { id, dist: d } = heap.pop();
    if (visited.has(id)) continue;
    visited.add(id);

    for (const { to, dist: edgeDist } of adjacency.get(id) ?? []) {
      const next = d + edgeDist;
      if (next < (dist.get(to) ?? Infinity)) {
        dist.set(to, next);
        prev.set(to, id);
        heap.push({ id: to, dist: next });
      }
    }
  }

  return prev;
}

function reconstructPath(prev, start, end) {
  if (start === end) return null;
  const path = [end];
  let current = end;
  while (current !== start) {
    const p = prev.get(current);
    if (p === undefined) return null;
    path.push(p);
    current = p;
  }
  return path.reverse();
}

function round(n, decimals) {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function pathToRoute(path, nodePos) {
  const points = path.map((id) => nodePos.get(id));
  const route = [];

  for (let i = 0; i < points.length; i++) {
    const isLast = i === points.length - 1;
    const heading = isLast ? route[i - 1]?.heading ?? 0 : bearing(points[i], points[i + 1]);
    route.push({ lat: round(points[i].lat, 6), lng: round(points[i].lng, 6), heading: round(heading, 1) });
  }

  return route;
}

function generateRoutes({ nodePos, adjacency }, count) {
  const ids = [...nodePos.keys()].filter((id) => (adjacency.get(id) ?? []).length > 0);
  const routes = [];
  let guard = 0;

  while (routes.length < count && guard < count * 20) {
    guard++;
    const start = ids[Math.floor(Math.random() * ids.length)];
    const end = ids[Math.floor(Math.random() * ids.length)];
    if (start === end) continue;

    const prev = dijkstra(adjacency, start);
    const path = reconstructPath(prev, start, end);
    if (!path || path.length < MIN_ROUTE_POINTS) continue;

    routes.push(pathToRoute(path, nodePos));
  }

  return routes;
}

async function main() {
  const osm = await fetchOverpass();
  const { nodePos, adjacency } = toGraph(osm);
  console.log(`Parsed ${nodePos.size} nodes`);

  const routes = generateRoutes({ nodePos, adjacency }, ROUTE_COUNT);
  console.log(`Generated ${routes.length}/${ROUTE_COUNT} routes`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'sf-routes.json'), JSON.stringify(routes));

  console.log(`Wrote ${path.join(OUT_DIR, 'sf-routes.json')}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
