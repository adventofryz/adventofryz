/// <reference lib="webworker" />

// Offloads the heavy one-time setup work — fetching + parsing the ~4MB route
// file and building the 5,000-vehicle fleet (cloning routes, computing
// distances) — off the main thread. This was blocking work happening right
// when the demo mounts; the per-frame render loop and the poll/merge logic
// still run on the main thread (they have to — MapLibre/deck.gl need a real
// WebGL canvas, which workers can't provide) but the initial burst no longer
// competes with the page's own responsiveness.

import { createFleet } from './simulate';
import { buildMetadata } from './poller';
import type { RoutePoint } from './types';

self.onmessage = async (e: MessageEvent<{ targetCount: number }>) => {
  const { targetCount } = e.data;

  const routes: RoutePoint[][] = await fetch('/data/sf-routes.json').then((r) => r.json());
  const fleet = createFleet(routes, targetCount);
  const metadata = buildMetadata(fleet);

  self.postMessage({ fleet, metadata: Array.from(metadata.entries()) });
};
