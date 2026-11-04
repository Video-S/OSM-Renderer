# ADR-0001: Geographic Coordinates, Projection, and Local World Coordinates

## Metadata

- **Decision ID**: `ADR-0001`
- **Status**: `Accepted`
- **Date**: `2026-10-27`
- **Deciders**: `Core Engineering Team`
- **Consulted**: `Map Rendering & Architecture Team`

---

## Context and Problem

OpenStreetMap provides geographic coordinates in standard WGS84 spherical degrees `[longitude, latitude]` (EPSG:4326). 3D WebGL renderers like Three.js operate on flat 32-bit floating-point Euclidean Cartesian coordinates. If spherical coordinates or large Web Mercator coordinates (e.g. coordinates in the millions of meters) are used directly in vertex shaders, precision jitter and geometry wobbling occur due to 32-bit float limitations.

The system requires an accurate, low-overhead projection mechanism that maps geographic degrees into local Euclidean metric coordinates `[x, y, z]` for typical urban neighborhood viewports ($\sim 0.5\text{ km}$ to $5\text{ km}$) while supporting exact round-trip inverse transformation.

---

## Decision

We adopt a **Local Equirectangular Tangent Projection** anchored at the dataset's geographic centroid `(originLon, originLat)`:

- **Metric Coordinate System**:
  - `1 unit = 1.0 meter`.
  - `+X` points East: $X = R_{\text{WGS84}} \cdot (\text{lon} - \text{originLon}) \cdot \frac{\pi}{180} \cdot \cos(\text{originLat} \cdot \frac{\pi}{180})$.
  - `+Y` points Up: Vertical elevation above ground.
  - `+Z` points South: $Z = -R_{\text{WGS84}} \cdot (\text{lat} - \text{originLat}) \cdot \frac{\pi}{180}$ (North is $-Z$).
- **Centralized Transformer**:
  - Implemented in `src/world/WorldCoordinates.ts` via the `WorldCoordinates` class and standalone functions `projectToLocalMeters` and `unprojectToGeo`.

---

## Alternatives Considered

1. **Global Web Mercator (EPSG:3857)**:
   - *Pros*: Standard in 2D slippy web maps.
   - *Cons*: Large coordinate numbers ($> 10^7\text{ m}$) cause severe vertex jitter in standard Three.js float32 buffers unless high-precision camera-relative rendering or custom shaders are introduced. Latitude distortion increases at high latitudes.
2. **Universal Transverse Mercator (UTM)**:
   - *Pros*: Highly conformal with minimal distortion within standard 6-degree zones.
   - *Cons*: High mathematical complexity, discontinuous zone boundaries, and unnecessary overhead for local neighborhood tiles.

---

## Consequences and Trade-Offs

### Positive
- Zero vertex jitter: Local coordinates remain comfortably within small numerical ranges ($[-2500, +2500]$ meters).
- Fast and computationally trivial: Fast trigonometric projection suitable for batch processing thousands of vertices.
- Intuitive alignment: $1\text{ unit} = 1\text{ meter}$ directly simplifies road widths, building heights, and elevation policies.

### Negative / Neutral
- Bounded validity: The flat-Earth approximation degrades if features span more than $\sim 25\text{ km}$ from the origin. Acceptable for Goalpost 1 urban neighborhood scopes.

---

## Related Source Modules

- `src/world/WorldCoordinates.ts`
- `src/world/LocalGeoJsonProvider.ts`
- `src/world/OsmApiProvider.ts`

---

## Tests and Evidence

- `src/world/WorldCoordinates.test.ts`:
  - `projectToLocalMeters maps origin coordinate to (0, 0)`
  - `projectToLocalMeters correctly positions East and North offsets`
  - `unprojectToGeo provides exact round-trip inverse transformation`
  - `distance consistency: local euclidean distance closely matches haversine for 1km scale`

---

## Superseded or Related Decisions

- None.
