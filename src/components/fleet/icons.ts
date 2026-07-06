export interface IconMappingEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorY: number;
  mask: boolean;
}

export interface IconAtlas {
  image: HTMLCanvasElement;
  mapping: Record<'moving' | 'idle', IconMappingEntry>;
}

// Rasterized at 2x the typical display size (see getSize in FleetMap.tsx) so
// downscaling stays crisp rather than sampling a low-res source.
const ICON_SIZE = 64;

// A chevron with a concave back — the standard "heading/direction" marker
// shape used by Google Maps' location arrow and most fleet-tracking UIs —
// reads as "pointing somewhere" far more clearly than a plain triangle. The
// dark outline keeps it legible against whatever color the basemap renders
// underneath (roads, parks, water all vary on a real map tile).
function drawVehicleIcon(ctx: CanvasRenderingContext2D, offsetX: number, color: string) {
  const cx = offsetX + ICON_SIZE / 2;
  const cy = ICON_SIZE / 2;
  const noseY = cy - 22;
  const shoulderY = cy + 14;
  const shoulderX = 16;
  const notchY = cy + 2;

  ctx.beginPath();
  ctx.moveTo(cx, noseY);
  ctx.lineTo(cx + shoulderX, shoulderY);
  ctx.quadraticCurveTo(cx, notchY, cx - shoulderX, shoulderY);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();

  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(10, 14, 20, 0.85)';
  ctx.stroke();
}

// Builds a tiny in-memory icon atlas (two chevrons) for deck.gl's IconLayer —
// no external image asset needed. Colors are passed in so they stay in sync
// with the site's CSS custom properties instead of being duplicated here.
export function buildVehicleIconAtlas(movingColor: string, idleColor: string): IconAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE * 2;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  drawVehicleIcon(ctx, 0, movingColor);
  drawVehicleIcon(ctx, ICON_SIZE, idleColor);

  return {
    image: canvas,
    mapping: {
      moving: { x: 0, y: 0, width: ICON_SIZE, height: ICON_SIZE, anchorY: ICON_SIZE / 2, mask: false },
      idle: { x: ICON_SIZE, y: 0, width: ICON_SIZE, height: ICON_SIZE, anchorY: ICON_SIZE / 2, mask: false },
    },
  };
}
