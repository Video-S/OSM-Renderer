[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadWindingDefect

# Interface: GraphRoadWindingDefect

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:104

Detailed attribution for a winding or normal-orientation defect detected on an at-grade road,
path, step-tread, or junction triangle (`M2.3-E2`).

## Properties

### area

> **area**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:136

Geometric area of the triangle in square meters (`0.5 * |cross(v1 - v0, v2 - v0)|`).

***

### faceIndex

> **faceIndex**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:108

Zero-based triangle face index (`indexOffset / 3`) within the mesh geometry.

***

### featureId?

> `optional` **featureId?**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:110

Graph edge, sub-segment, or junction feature ID resolved from `userData.faceRanges`.

***

### geometricNormal

> **geometricNormal**: \[`number`, `number`, `number`\]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:126

Unit geometric face normal computed via `normalize(cross(v1 - v0, v2 - v0))`.

***

### meshName

> **meshName**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:106

Name of the Three.js `Mesh` containing the defective triangle (e.g. `Roads_residential`).

***

### minStoredNormalDot

> **minStoredNormalDot**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:134

Minimum dot product between `geometricNormal` and the 3 stored vertex normals.

***

### reason

> **reason**: `"inverted_winding"` \| `"non_upward_horizontal_face"` \| `"stored_normal_mismatch"` \| `"non_finite_vertex"`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:114

Failure classification.

***

### sourceFeatureId?

> `optional` **sourceFeatureId?**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:112

Upstream source feature ID (`way/...`) resolved from `userData.faceRanges`.

***

### storedNormals

> **storedNormals**: \[\[`number`, `number`, `number`\], \[`number`, `number`, `number`\], \[`number`, `number`, `number`\]\]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:128

Stored vertex normals `[n0, n1, n2]` from the geometry's `normal` buffer attribute.

***

### vertices

> **vertices**: \[\[`number`, `number`, `number`\], \[`number`, `number`, `number`\], \[`number`, `number`, `number`\]\]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:120

World-space triangle vertex coordinates `[v0, v1, v2]`.
