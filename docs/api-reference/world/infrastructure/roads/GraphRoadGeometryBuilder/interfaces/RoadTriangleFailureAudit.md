[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / RoadTriangleFailureAudit

# Interface: RoadTriangleFailureAudit

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:536

## Properties

### areaDegenerateFaces

> **areaDegenerateFaces**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:539

***

### fatalFaces

> **fatalFaces**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:541

***

### firstFatal?

> `optional` **firstFatal?**: `object`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:543

First face that actually causes validation to reject the road.

#### areaSquareMeters?

> `optional` **areaSquareMeters?**: `number`

#### faceIndex

> **faceIndex**: `number`

#### normalY?

> `optional` **normalY?**: `number`

#### reason

> **reason**: `"nonfinite"` \| `"non-upward"` \| `"no-valid-faces"`

#### vertices?

> `optional` **vertices?**: \[`number`, `number`, `number`\][]

***

### problemFaces

> **problemFaces**: `object`[]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:545

Bounded geometric evidence; only problematic faces, not all valid faces.

#### altitudeMeters?

> `optional` **altitudeMeters?**: `number`

#### areaSquareMeters?

> `optional` **areaSquareMeters?**: `number`

#### disposition

> **disposition**: `"pruned-degenerate"` \| `"pruned-float32-sliver"` \| `"fatal-nonfinite"` \| `"fatal-non-upward"`

#### faceIndex

> **faceIndex**: `number`

#### float32UlpMeters?

> `optional` **float32UlpMeters?**: `number`

#### normalY?

> `optional` **normalY?**: `number`

#### vertices?

> `optional` **vertices?**: \[`number`, `number`, `number`\][]

***

### prunableFloat32SliverFaces

> **prunableFloat32SliverFaces**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:540

***

### totalFaces

> **totalFaces**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:537

***

### upwardFaces

> **upwardFaces**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:538
