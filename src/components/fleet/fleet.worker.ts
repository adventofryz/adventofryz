/// <reference lib="webworker" />

// Offloads the one-time setup — fetching the route file and building the
// fleet — off the main thread, so it doesn't compete with page load. The
// render loop and poll/merge logic stay on the main thread since
// MapLibre/deck.gl need a real WebGL canvas, which workers can't provide.

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
