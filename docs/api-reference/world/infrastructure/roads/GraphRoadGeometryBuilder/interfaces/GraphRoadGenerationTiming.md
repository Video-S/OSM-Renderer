[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadGenerationTiming

# Interface: GraphRoadGenerationTiming

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:423

High-resolution wall-clock timing breakdown (`ms`) for at-grade road geometry generation.
Stored separately from `GraphRoadRenderStats` so deterministic counter snapshots remain
bit-for-bit identical across runs.

## Properties

### footprintConstructionTimeMs

> **footprintConstructionTimeMs**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:427

Wall-clock time (`ms`) spent constructing rounded stroke footprints (primitive setup + union).

***

### ownershipClippingTimeMs

> **ownershipClippingTimeMs**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:433

Wall-clock time (`ms`) spent in bbox blocker checks and `polygonClipping.difference` ownership clipping.

***

### polygonUnionTimeMs

> **polygonUnionTimeMs**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:431

Wall-clock time (`ms`) spent inside `polygonClipping.union` during footprint buffering.

***

### primitiveConstructionTimeMs

> **primitiveConstructionTimeMs**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:429

Wall-clock time (`ms`) spent constructing segment rectangle and disk primitives prior to union.

***

### totalRoadGenerationTimeMs

> **totalRoadGenerationTimeMs**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:425

Total wall-clock time (`ms`) spent inside `buildGraphAtGradeRoadGeometries`.

***

### triangulationAndValidationTimeMs

> **triangulationAndValidationTimeMs**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:435

Wall-clock time (`ms`) spent in `createShapesFromMultiPolygon`, `ShapeGeometry`, and `validateAndPruneHorizontalGeometry`.
