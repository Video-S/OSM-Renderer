# ADR-0003: Loaded Region Boundary Clipping and Bounded Scene Sizing

## Metadata

- **Decision ID**: `ADR-0003`
- **Status**: `Accepted`
- **Date**: `2026-10-27`
- **Deciders**: `Core Engineering Team`
- **Consulted**: `Data Pipeline & Rendering Team`

---

## Context and Problem

When loading OpenStreetMap data for a specific geographic region (e.g. within a given radius or bounding box), raw OSM ways and relations extend arbitrarily far beyond the requested area (e.g., long motorways, rivers, or large park boundaries that span hundreds of kilometers).

If unclipped, these features bleed indefinitely across the 3D scene, distorting the scene bounding box, breaking camera framing calculations, and causing rendering performance drops on off-screen geometry. Furthermore, standard Sutherland–Hodgman polygon clipping can corrupt concave polygons (such as U-shaped building wings or holed courtyard footprints) that cross the clipping boundary, falsely connecting disconnected prongs across empty bays.

---

## Decision

We enforce **strict bounded-region clipping** at data ingestion time against an axis-aligned box `[-clipRadius, +clipRadius]` in meters:

1. **Polyline Clipping (`clipPolylineToBox`)**:
   - Uses the **Liang-Barsky** parametric algorithm to clip linear features (roads, railways, waterways) to the bounding box.
   - Preserves contiguous polyline sub-segments and associates raw OSM node IDs with clipped vertices.
2. **Polygon Clipping (`clipPolygonRingsToBox`)**:
   - Primary pass: Evaluates polygon-to-box intersection using `polygonClipping.intersection()`.
   - **Topology-Aware Convex Decomposition Fallback (`clipPolygonWithTopologyAwareFallback`)**:
     - Decomposes concave polygons and interior holes into convex triangles via `THREE.ShapeUtils.triangulateShape`.
     - Clips each convex triangle against the axis-aligned box with exact Sutherland–Hodgman clipping.
     - Reconstructs clean MultiPolygon components via `polygonClipping.union()`.
     - Guarantees that clipping a concave U-shaped polygon produces distinct MultiPolygon parts (`polygons.length > 1`) instead of a single malformed polygon with bridge segments across the bay.
     - Preserves fully interior courtyard holes while turning boundary-crossing holes into boundary indentations.
     - Drops micro-sliver holes ($< 0.05\text{ m²}$) or self-intersecting holes without discarding the valid outer building ring.
3. **Bounded Scene Sizing**:
   - Scene bounding boxes and camera framing bounds reflect the strictly clipped geometry, ensuring predictable orthographic zoom and framing.

---

## Alternatives Considered

1. **Centroid Filtering Only**:
   - *Pros*: Very cheap to compute.
   - *Cons*: Keeps entire multi-kilometer motorways or rivers if their centroid falls inside, or drops huge buildings whose centroid falls slightly outside while their footprint covers half the map.
2. **GPU Fragment Shader Clipping Planes**:
   - *Pros*: Clips pixels during rendering.
   - *Cons*: Geometry buffers remain bloated with off-screen triangles, draw call vertex counts remain high, and bounding boxes remain inflated.

---

## Consequences and Trade-Offs

### Positive
- Strict spatial bounds: 100% of generated 3D vertices stay within the requested metric envelope `[-clipRadius, +clipRadius]`.
- Reliable camera framing: Camera framing tightly fits the queried urban area without letterboxing empty space.
- Watertight topology: Disjoint polygon pieces cut by boundaries are emitted as separate MultiPolygon components.

### Negative / Neutral
- Ingestion CPU cost: Performing polygon clipping during parsing adds a brief ingestion cost, offset by faster 3D rendering and lower GPU memory usage.

---

## Related Source Modules

- `src/world/LocalGeoJsonProvider.ts` (`clipPolylineToBox`, `clipPolygonRingsToBox`, `clipPolygonWithTopologyAwareFallback`)
- `src/scene/CameraController.tsx` (`computeProjectedBoundsFraming`)

---

## Tests and Evidence

- `src/world/JunctionAndTopology.test.ts`:
  - `Issue 4 Regression: Building polygon clipping at loaded-region boundary covers all 8 spatial and validity cases`
  - `clipPolygonRingsToBox topology-aware fallback handles concave polygons with disconnected components and boundary-crossing holes without malformation`
  - `clipPolygonWithTopologyAwareFallback direct caller behavior: handles open rings, preserves fully interior holes, drops sliver holes, and maintains triangle seam integrity`

---

## Superseded or Related Decisions

- Related to `ADR-0007` (Camera Framing).
