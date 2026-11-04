# ADR-0005: Source-Feature Provenance Tracking and Diagnostic Accounting

## Metadata

- **Decision ID**: `ADR-0005`
- **Status**: `Accepted`
- **Date**: `2026-10-27`
- **Deciders**: `Core Engineering Team`
- **Consulted**: `Diagnostics & QA Team`

---

## Context and Problem

In procedural 3D map viewers, thousands of raw GeoJSON/OSM features are parsed, clipped, chained, filtered, and merged into a handful of batched Three.js `BufferGeometry` instances to maintain high WebGL rendering performance (minimizing DrawCalls).

When individual geometries are merged, their original feature identity and tags are lost unless explicitly preserved. Without provenance tracking:
1. User clicks or raycasts cannot identify which specific building, road, or park was clicked.
2. Debugging geometry defects (e.g. why a specific building disappeared or why an overlap occurred) is nearly impossible because the correlation between the raw GeoJSON feature and the rendered triangles is broken.
3. Silent drops of degenerate or unsupported features occur without visibility.

---

## Decision

We implement an end-to-end **provenance tracking and diagnostic accounting pipeline**:

1. **Feature Provenance via Face Ranges (`faceRanges`)**:
   - In `GeometryBuilder.ts`, when individual feature sub-geometries are merged into unified BufferGeometries (e.g., all primary roads or all building walls), the builder records face index ranges:
     ```typescript
     export interface FaceFeatureRange {
       startFace: number;
       endFace: number;
       info: InspectableFeatureInfo;
     }
     ```
   - On raycast hit testing, `resolveInspectedFeature` uses binary search over `userData.faceRanges` to instantly map the clicked face index to the original OSM feature tags, name, layer, and source ID.
2. **Comprehensive Diagnostic Metrics (`MapFeatureDiagnostics`)**:
   - `LocalGeoJsonProvider` records strict feature accounting:
     - `sourceFeaturesReceived`: Total raw features.
     - `sourceFeaturesClassified`: Successfully categorized features.
     - `totalFeaturesParsed`: Emitted feature parts.
     - `parsedByCategory`: Breakdown by type.
     - `rejectedInvalid`: Degenerate or self-intersecting geometries discarded, with explicit reason codes and sample IDs.
     - `sourceFeaturesRendered` & `constructedMeshesCount`: Metrics for the final scene graph.
3. **Multi-Source Junction Provenance**:
   - When multiple roads meet at a junction polygon, the synthesized junction geometry records all contributing road feature IDs in its face metadata so inspection correctly identifies all intersecting streets.

---

## Alternatives Considered

1. **Individual Mesh Per Feature**:
   - *Pros*: Trivial hit testing via `mesh.userData`.
   - *Cons*: Thousands of separate draw calls per frame; catastrophic performance drop on WebGL.
2. **GPU ID Color Picking Texture**:
   - *Pros*: Fast pixel readback.
   - *Cons*: Requires an extra render pass, second framebuffer, and custom ID encoding shaders.

---

## Consequences and Trade-Offs

### Positive
- Sub-millisecond raycast inspection across millions of merged triangles without extra render passes.
- Transparent accounting: Immediate visibility into how many features were parsed, clipped, or rejected.
- Deterministic debugging: Every rendered triangle can be traced back to its raw OSM way/node ID.

### Negative / Neutral
- Array memory: Retaining `faceRanges` arrays in JavaScript memory adds a small memory overhead (~several kilobytes per layer), well within browser limits.

---

## Related Source Modules

- `src/types/MapFeature.ts` (`InspectableFeatureInfo`, `MapFeatureDiagnostics`)
- `src/world/GeometryBuilder.ts` (`resolveInspectedFeature`, `FaceFeatureRange`)
- `src/world/LocalGeoJsonProvider.ts` (`parseGeoJson` diagnostics)

---

## Tests and Evidence

- `src/world/JunctionAndTopology.test.ts`:
  - `Diagnostic provenance tracks retained, chained, and deduplicated features independently`
  - `Road junctions preserve all contributing sourceFeatureIds on faceRanges`

---

## Superseded or Related Decisions

- Related to `ADR-0006` (GPU Resource Management).
