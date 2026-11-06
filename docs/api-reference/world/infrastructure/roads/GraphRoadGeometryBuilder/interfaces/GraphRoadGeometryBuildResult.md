[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadGeometryBuildResult

# Interface: GraphRoadGeometryBuildResult

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:463

Output of `buildGraphAtGradeRoadGeometries` consumed by `GeometryBuilder.buildScene()` when `roads === 'graph'`.

## Properties

### atGradeRoadEndpoints

> **atGradeRoadEndpoints**: \[`number`, `number`\][]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:467

At-grade road polyline points for Stage 6D bridge ramp connection detection.

***

### fullySubtractedRoadIds

> **fullySubtractedRoadIds**: `Set`\<`string`\>

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:471

Set of edge/source feature IDs completely subtracted by 2D Boolean clipping.

***

### renderedSourceIds

> **renderedSourceIds**: `Set`\<`string`\>

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:469

Set of source feature IDs whose geometry was actually emitted.

***

### roadsByClass

> **roadsByClass**: `Map`\<[`RoadClass`](../../../../../types/MapFeature/type-aliases/RoadClass.md), `object`[]\>

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:465

Per-class arrays of registered `BufferGeometry` + `InspectableFeatureInfo` items (ribbons, treads, junctions).

***

### stats

> **stats**: [`GraphRoadRenderStats`](GraphRoadRenderStats.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:473

Detailed Stage E2 graph-road rendering statistics.
