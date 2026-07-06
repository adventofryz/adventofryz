# Portfolio Site — Plan

## Stack
- Astro, deployed as a static site (Astro's default output mode)
- No frontend framework decided yet for interactive islands beyond what MapLibre/deck.gl require (vanilla JS client scripts, not React, unless a specific integration need comes up)

## About (context for tone/content decisions, not verbatim site copy)
Full-stack engineer, 8+ years, currently specialized in frontend/geospatial work (React/TypeScript, MapLibre, deck.gl, Node.js, PostgreSQL, Azure). The site's job is to showcase that specialization — not read as a generic "full-stack developer" template.

## Decided

### Page structure (single page, v1, in this order)

1. **Hero**
   - One line stating what I do — sharper than "full-stack developer," e.g. "frontend engineer specializing in geospatial interfaces"
   - No headshot, no photo of me anywhere on the page
   - Fade + rise in on load (~400ms) — the only hero animation

2. **Featured work — case study 1 (centerpiece, interactive)**
   - Rebuilt mini fleet-tracking map: real-time position rendering of ~5,000 vehicles
   - Stack: MapLibre GL JS + deck.gl IconLayer for vehicle markers
   - Vehicles rendered as rotated triangle/arrow icons, color-coded by state (moving vs. idle = muted gray) — not literal car icons
   - Data: real continuous GPS trace data (Cabspotting SF or Rome taxi datasets), cloned/offset to scale up to ~5,000 concurrent vehicles. NOT NYC TLC pickup/dropoff data (would require fake road interpolation)
   - Embedded live and interactive (no screenshot/video); animation starts when scrolled into view
   - Short writeup (2-3 sentences): problem (rendering/updating thousands of live positions performantly), approach, result
   - Tag chips: MapLibre, deck.gl, React
   - Links: source code + live demo

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
- Exact GPS dataset: Cabspotting SF vs. Rome taxi traces
- Nav bar: links are decided (Work / About / Contact, max 3) but not yet scaffolded as a component
- MapLibre/deck.gl dependencies aren't in package.json yet — added when the fleet map demo is actually built
- `npm audit` flags astro@5.18.2's bundled esbuild (Windows dev-server arbitrary file read) plus a few Astro SSR/render XSS advisories, fixed only by jumping to astro@7.0.6 (breaking, skips v6). Deferred for now — low relevance to a static site with no user input; revisit before deploying or before running the dev server on a shared network

## Current status
Scaffold only: folder structure, skeleton components, no component logic written yet. Node pinned to 24.15.0 via `.nvmrc` (was 18.20.4, below Astro 5's minimum). `npm install` done, `astro build` verified working (dist/index.html generated from the four skeleton sections).
