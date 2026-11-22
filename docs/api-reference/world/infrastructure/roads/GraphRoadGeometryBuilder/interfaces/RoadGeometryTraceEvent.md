[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / RoadGeometryTraceEvent

# Interface: RoadGeometryTraceEvent

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:506

Input configuration for `buildGraphAtGradeRoadGeometries`.

## Properties

### blockerCount?

> `optional` **blockerCount?**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:525

***

### edgeId

> **edgeId**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:508

***

### invalidTriangle?

> `optional` **invalidTriangle?**: `object`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:516

First unexpected triangle on a validation failure, if one exists.

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

### message?

> `optional` **message?**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:527

***

### polygonCount?

> `optional` **polygonCount?**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:524

***

### sourceFeatureId

> **sourceFeatureId**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:507

***

### stage

> **stage**: `"filtered-visibility"` \| `"invalid-edge"` \| `"invalid-subsegment"` \| `"stroke-empty"` \| `"fully-subtracted"` \| `"bbox-outside"` \| `"empty-shapes"` \| `"invalid-triangles"` \| `"clip-empty"` \| `"clip-invalid"` \| `"fault-injected-rejection"` \| `"emitted"` \| `"exception"`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:510

***

### subId

> **subId**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:509

***

### triangleAudit?

> `optional` **triangleAudit?**: [`RoadTriangleFailureAudit`](RoadTriangleFailureAudit.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:526

***

### triangleCount?

> `optional` **triangleCount?**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:523
