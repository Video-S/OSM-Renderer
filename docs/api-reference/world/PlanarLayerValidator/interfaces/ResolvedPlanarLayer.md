[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / ResolvedPlanarLayer

# Interface: ResolvedPlanarLayer

Defined in: world/PlanarLayerValidator.ts:30

## Properties

### area

> **area**: `number`

Defined in: world/PlanarLayerValidator.ts:39

***

### band

> **band**: `"substrate"` \| `"above_water"`

Defined in: world/PlanarLayerValidator.ts:36

***

### baseTier

> **baseTier**: `number`

Defined in: world/PlanarLayerValidator.ts:37

***

### bbox

> **bbox**: [`PlanarBoundingBox`](PlanarBoundingBox.md)

Defined in: world/PlanarLayerValidator.ts:42

***

### category

> **category**: `"water"` \| `"park"` \| `"landuse"`

Defined in: world/PlanarLayerValidator.ts:33

***

### depthOffset

> **depthOffset**: `object`

Defined in: world/PlanarLayerValidator.ts:48

#### polygonOffset?

> `optional` **polygonOffset?**: `boolean`

#### polygonOffsetFactor?

> `optional` **polygonOffsetFactor?**: `number`

#### polygonOffsetUnits?

> `optional` **polygonOffsetUnits?**: `number`

***

### elevationY

> **elevationY**: `number`

Defined in: world/PlanarLayerValidator.ts:44

Uniform flush physical elevation (+0.025m for all mutually exclusive ground-cover fills)

***

### hasSurfaceMarkings

> **hasSurfaceMarkings**: `boolean`

Defined in: world/PlanarLayerValidator.ts:45

***

### higherOverlappingIds

> **higherOverlappingIds**: `string`[]

Defined in: world/PlanarLayerValidator.ts:54

IDs of polygons that replace (carve out) this polygon in their shared 2D region

***

### higherOverlappingMultiPolygon

> **higherOverlappingMultiPolygon**: [`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

Defined in: world/PlanarLayerValidator.ts:56

MultiPolygon geometry of higher-priority replacing features (for clipping procedural markings)

***

### id

> **id**: `string`

Defined in: world/PlanarLayerValidator.ts:31

***

### isDeduplicatedInto?

> `optional` **isDeduplicatedInto?**: `string`

Defined in: world/PlanarLayerValidator.ts:60

True if merged into another canonical duplicate polygon

***

### markingElevationY

> **markingElevationY**: `number`

Defined in: world/PlanarLayerValidator.ts:46

***

### perimeter

> **perimeter**: `number`

Defined in: world/PlanarLayerValidator.ts:41

***

### renderOrder

> **renderOrder**: `number`

Defined in: world/PlanarLayerValidator.ts:47

***

### resolvedArea

> **resolvedArea**: `number`

Defined in: world/PlanarLayerValidator.ts:40

***

### resolvedMultiPolygon

> **resolvedMultiPolygon**: [`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

Defined in: world/PlanarLayerValidator.ts:58

Final non-overlapping MultiPolygon geometry after batch Boolean union subtraction

***

### semanticClass

> **semanticClass**: [`SemanticSurfaceClass`](../type-aliases/SemanticSurfaceClass.md)

Defined in: world/PlanarLayerValidator.ts:35

***

### sourceFeatureIds

> **sourceFeatureIds**: `string`[]

Defined in: world/PlanarLayerValidator.ts:32

***

### subtype

> **subtype**: `string`

Defined in: world/PlanarLayerValidator.ts:34

***

### topologicalRank

> **topologicalRank**: `number`

Defined in: world/PlanarLayerValidator.ts:38
