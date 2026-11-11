[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadGeometryBuildResult

# Interface: GraphRoadGeometryBuildResult

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:527

Output of `buildGraphAtGradeRoadGeometries` consumed by `GeometryBuilder.buildScene()` when `roads === 'graph' | 'graph-surface'`.

## Properties

### atGradeRoadEndpoints

> **atGradeRoadEndpoints**: \[`number`, `number`\][]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:531

At-grade road polyline points for Stage 6D bridge ramp connection detection.

***

### fullySubtractedRoadIds

> **fullySubtractedRoadIds**: `Set`\<`string`\>

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:535

Set of edge/source feature IDs completely subtracted by 2D Boolean clipping.

***

### renderedSourceIds

> **renderedSourceIds**: `Set`\<`string`\>

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:533

Set of source feature IDs whose geometry was actually emitted.

***

### roadsByClass

> **roadsByClass**: `Map`\<[`RoadClass`](../../../../../types/MapFeature/type-aliases/RoadClass.md), `object`[]\>

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:529

Per-class arrays of registered `BufferGeometry` + `InspectableFeatureInfo` items (ribbons, treads, junctions).

***

### stats

> **stats**: [`GraphRoadRenderStats`](GraphRoadRenderStats.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:537

Deterministic Stage E2 / E2+ graph-road rendering statistics and operation counters.

***

### timing

> **timing**: [`GraphRoadGenerationTiming`](GraphRoadGenerationTiming.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:539

High-resolution wall-clock timing breakdown (`ms`) for this road generation pass.
