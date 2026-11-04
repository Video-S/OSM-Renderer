# ADR-0002: Boundary-Derived Road Junction Polygon Synthesis and Coplanar Overlap Resolution

## Metadata

- **Decision ID**: `ADR-0002`
- **Status**: `Accepted`
- **Date**: `2026-10-27`
- **Deciders**: `Core Engineering Team`
- **Consulted**: `Geometry & Rendering Team`

---

## Context and Problem

In typical naive 3D map renderers, road intersections are formed by blindly extruding overlapping road ribbons through shared junction nodes. Because road classes or intersecting ways often occupy identical or nearly identical physical elevations, overlapping coplanar triangles cause severe z-fighting, shimmering, and moiré artifacts at glancing camera angles.

Earlier iterations attempted to hide z-fighting by assigning artificial micro-offsets based on road classification (`primary` higher than `secondary`, higher than `residential`, higher than `footway`) or hashing feature IDs. This created stepped visual seams, broken elevation continuity, and did not resolve self-overlaps or same-class crossings.

---

## Decision

We eliminate coplanar road overlap at intersections through **geometric 2D boundary-derived junction meshing** while enforcing a **single uniform at-grade road baseline (`ROAD_SURFACE = 0.050 m`)**:

1. **Topological Junction Detection**:
   - `TopologicalNodeIndex` groups meeting road endpoints into topological junction nodes with shared layer scopes.
2. **Arc-Length Polyline Trimming (`trimPolylineByArcLength`)**:
   - Each incoming road ribbon is trimmed back along its true centerline arc length based on the envelope of the intersection (determined by the width and angle of intersecting roads).
   - Each trimmed road ribbon terminates in an orthogonal end portal connecting its left and right ribbon edges.
3. **Boundary-Derived Junction Polygon**:
   - A single flat junction polygon is synthesized directly from the ordered boundary vertices of the connecting road portals.
   - The junction polygon sits exactly at `ROAD_SURFACE = 0.050 m`, forming a watertight 0.0 mm coplanar seam with zero triangle overlap.
4. **Miter Clamping**:
   - Acute angle intersections clamp miter offsets (`miterScale <= 2.0`) to prevent sharp needle spikes from penetrating adjacent carriageways.
5. **Path vs. Carriageway Boolean Subtraction**:
   - When non-vehicular paths cross vehicular carriageways, the 2D footprint of vehicular roads is subtracted from the path geometry using `polygonClipping.difference()`.

---

## Alternatives Considered

1. **Elevation Micro-Tiers / Feature ID Offsets**:
   - *Pros*: Simple to implement.
   - *Cons*: Causes artificial vertical steps at intersections, visual floating, and fails at acute angles and same-class intersections. Micro-offsets conceal defects rather than solving them.
2. **Full-Scene 2D CSG Boolean Union of All Roads**:
   - *Pros*: Completely eliminates overlaps.
   - *Cons*: Extremely slow on complex urban networks ($O(N^2)$ polygon union), destroys individual road attributes and texturing coordinates, and causes ear-clipping artifacts on huge non-convex polygons.

---

## Consequences and Trade-Offs

### Positive
- Zero z-fighting at intersections: Confirmed by `ZFightingValidator` with 0 positive-area overlapping triangles.
- Consistent physical elevation: All at-grade roads remain flat at `0.050 m` without step discontinuities.
- Preserved road metadata: Road ribbons maintain clean UV mapping, tangent normals, and `faceRanges` for feature inspection.

### Negative / Neutral
- Geometry complexity: Requires careful topological trimming math and miter clamping at acute forks.

---

## Related Source Modules

- `src/world/GeometryBuilder.ts` (`generateRoadRibbon`, Stage 3 junction generation)
- `src/world/ElevationPolicy.ts` (`ROAD_SURFACE = 0.050`, `MICRO_TIER_STEP = 0.0`)
- `src/world/TopologicalNodeIndex.ts`
- `src/world/ZFightingValidator.ts`

---

## Tests and Evidence

- `src/world/JunctionAndTopology.test.ts`:
  - `Boundary-derived junction meshing trims incoming road ribbons and synthesizes coplanar junction polygon`
  - `Acute angle fork applies miter clamping and preserves zero road-vs-road triangle overlap`
  - `Road-network triangle overlap and portal continuity validator passes across all 7 intersection archetypes`

---

## Superseded or Related Decisions

- Supersedes earlier experiments with road-class elevation tiers.
- Related to `ADR-0004` (Grade-Separated Infrastructure).
