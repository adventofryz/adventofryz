# Portfolio Site — Plan

## Stack
- Astro, deployed as a static site (Astro's default output mode), on Cloudflare Workers (static assets) at riymoh.com
- `@astrojs/react` added for one interactive island (the fleet map); rest of the site stays framework-free static HTML

## About (context for tone/content decisions, not verbatim site copy)
Full-stack engineer, 8+ years, currently specialized in frontend/geospatial work (React/TypeScript, MapLibre, deck.gl, Node.js, PostgreSQL, Azure). The site's job is to showcase that specialization — not read as a generic "full-stack developer" template.

## Decided

### Page structure (single page, v1, in this order)

1. **Hero**
   - One line stating what I do — sharper than "full-stack developer," e.g. "frontend engineer specializing in geospatial interfaces"
   - No headshot, no photo of me anywhere on the page
   - Fade + rise in on load (~400ms) — the only hero animation

2. **Featured work — case study 1 (centerpiece, interactive)**
   - Real implementation (not a placeholder): MapLibre GL + deck.gl (`IconLayer` for vehicles, `TripsLayer` for fading trails), 5,000 vehicles, React island (`FleetMap.tsx`) hydrated via `client:visible` — hydration itself satisfies "animation starts on scroll into view," no manual IntersectionObserver needed
   - Vehicles rendered as chevron icons (concave-back arrow, the Google-Maps-heading-indicator shape) via an in-memory canvas atlas, color-coded by state (moving = `--accent` teal, idle ~15% = `--text-muted` gray), each with a soft glow halo so they stay the visual focal point against the basemap
   - **Data provenance (decided after research):** genuine SF taxi GPS (Cabspotting/EPFL) is gated behind CRAWDAD/IEEE registration — not automatable, and would be an external runtime dependency either way. Instead: the **real SF street network** (OpenStreetMap, via Overpass API) is fetched **once at build time** (`npm run build:data` → `scripts/build-fleet-data.mjs`) and committed to `public/data/sf-routes.json` (700 shortest-path routes over a widened downtown-core bbox, cloned/offset to 5,000 vehicles so they spread out rather than cluster). Movement is *simulated over these real roads*, described honestly in the writeup as simulation, not replayed GPS
   - **Basemap is a deliberate exception to "no external calls at runtime":** hand-drawn road geometry + deck.gl's `TextLayer` never matched real cartography (label placement, road styling), so the visual basemap is CARTO's Voyager vector tiles (live, keyless) — real MapLibre labels/roads. Everything else (vehicle simulation, routing data) stays self-hosted; Overpass itself is still build-time-only
   - POI landmarks (hospital, mall, depot, etc.) are native MapLibre `circle`/`symbol` layers (not deck.gl TextLayer) so their labels render through the same glyph pipeline as the basemap's own labels — matching quality, not fontSettings tuning
   - **Data pipeline mirrors the real production system**: a mock poller (`src/components/fleet/poller.ts`) emits periodic `trackingPath` batches per vehicle that deliberately overlap the previous batch, and a merge step (`merge.ts`) dedupes by timestamp and stitches new points onto each vehicle's buffer without rewinding the playback cursor. Playback renders on a fixed delay (~1 poll interval past "now") so there's always a real buffered window to interpolate through — this is the actual engineering problem being demonstrated, not just "render lots of markers"
   - Stats bar (total/moving/idle), vehicle-click popover (id/plate/speed/heading + a flavor "job" like "Hospital transport"), zoom locked to not zoom out past the road network — all driven by real fleet state, not fixed placeholder numbers
   - Tag chips: MapLibre, deck.gl, React
   - Links: source code + live demo (still placeholder hrefs)
   - Case study writeup: tight "what it is/does" line + 3 real engineering challenges actually solved (overlapping-update stitching, latency smoothing, rendering at scale) — deliberately excludes demo-only artifacts (bbox sizing, route reuse) that wouldn't be real challenges in production

3. **Case study 2** — not built for v1. If added later: static screenshot + short caption only, smaller visual treatment than case study 1, not interactive (only one interactive centerpiece per page)

4. **Capability strip**
   - Plain text list, no logos, no proficiency bars/percentages
   - React/TypeScript, Node.js, PostgreSQL, MapLibre, deck.gl, Azure

5. **Contact / footer**
   - Email, GitHub, LinkedIn links only

### Explicitly excluded from v1
- No headshot or personal photos anywhere
- No LLM/AI evaluation work on the site yet (not confident enough to defend it in an interview context yet — revisit later)
- No second live project for v1
- No heavy animation — no scroll-jacking, no parallax, no per-element reveal animations beyond the hero fade-in and the map's scroll-into-view start
- No more than 3 nav links (Work / About / Contact)

## Not yet decided
- Second case study: what it is, when it gets added
- Source code + live demo links on the case study card are still `#` placeholders
- `npm audit` flags astro@5.18.2's bundled esbuild (Windows dev-server arbitrary file read) plus a few Astro SSR/render XSS advisories, fixed only by jumping to astro@7.0.6 (breaking, skips v6). Deferred for now — low relevance to a static site with no user input; revisit before deploying or before running the dev server on a shared network

## Current status
Site is built out: Nav (Riyaz wordmark + Work/About/Contact), Hero, Featured Work (real fleet map, see above), Capability Strip, Contact all implemented and styled (dark theme, teal accent, monospace labels). Deployed to Cloudflare Workers at riymoh.com (+ www redirect). Node pinned to 24.15.0 via `.nvmrc`. Regenerate fleet data with `npm run build:data` if the road/route bake ever needs refreshing (requires network; site itself doesn't).
