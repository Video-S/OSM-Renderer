[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadDegenerateTriangleDefect

# Interface: GraphRoadDegenerateTriangleDefect

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:144

Detailed attribution for a zero-area or near-zero-area degenerate triangle detected in a road mesh.

## Properties

### area

> **area**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:160

Geometric area of the triangle in square meters (`<= 1e-6 m²`).

***

### faceIndex

> **faceIndex**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:148

Zero-based triangle face index (`indexOffset / 3`) within the mesh geometry.

***

### featureId?

> `optional` **featureId?**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:150

Graph edge, sub-segment, or junction feature ID resolved from `userData.faceRanges`.

***

### meshName

> **meshName**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:146

Name of the Three.js `Mesh` containing the degenerate triangle.

***

### sourceFeatureId?

> `optional` **sourceFeatureId?**: `string`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:152

Upstream source feature ID (`way/...`) resolved from `userData.faceRanges`.

***

### vertices

> **vertices**: \[\[`number`, `number`, `number`\], \[`number`, `number`, `number`\], \[`number`, `number`, `number`\]\]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:154

World-space triangle vertex coordinates `[v0, v1, v2]`.
