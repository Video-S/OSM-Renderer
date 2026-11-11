[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [types/MapFeature](../README.md) / BarrierStructuralContext

# Interface: BarrierStructuralContext

Defined in: world/StructuralContextResolver.ts:27

## Properties

### associatedCorridorFeatureIds

> **associatedCorridorFeatureIds**: readonly `string`[]

Defined in: world/StructuralContextResolver.ts:43

Associated subterranean or cutting corridor source feature IDs (sorted).

***

### barrierId

> **barrierId**: `string`

Defined in: world/StructuralContextResolver.ts:28

***

### isUncertainNegativeLayer

> **isUncertainNegativeLayer**: `boolean`

Defined in: world/StructuralContextResolver.ts:41

True when `layer < 0` was present without any verified subterranean or cutting corridor association.

***

### kind

> **kind**: [`BarrierStructuralPlacementKind`](../type-aliases/BarrierStructuralPlacementKind.md)

Defined in: world/StructuralContextResolver.ts:30

***

### layer

> **layer**: `number`

Defined in: world/StructuralContextResolver.ts:31

***

### maxTopY

> **maxTopY**: `number`

Defined in: world/StructuralContextResolver.ts:35

Maximum top Y across all vertices of this barrier (m).

***

### minBaseY

> **minBaseY**: `number`

Defined in: world/StructuralContextResolver.ts:33

Minimum base Y across all vertices of this barrier (m).

***

### profile

> **profile**: readonly [`BarrierProfileVertex3D`](BarrierProfileVertex3D.md)[]

Defined in: world/StructuralContextResolver.ts:47

Per-vertex variable `[baseY, topY]` 3D profile along the barrier polyline.

***

### rendersInSubterraneanLayer

> **rendersInSubterraneanLayer**: `boolean`

Defined in: world/StructuralContextResolver.ts:39

True when the barrier is completely enclosed underground and should be placed in the subterranean structural layer.

***

### representativeElevationY

> **representativeElevationY**: `number`

Defined in: world/StructuralContextResolver.ts:37

Representative elevation reported in InspectableFeatureInfo (m).

***

### sharedNodeBarrierFeatureIds

> **sharedNodeBarrierFeatureIds**: readonly `string`[]

Defined in: world/StructuralContextResolver.ts:45

Associated approach/neighboring barrier source feature IDs sharing explicit OSM nodes (sorted).

***

### sourceFeatureId

> **sourceFeatureId**: `string`

Defined in: world/StructuralContextResolver.ts:29
