[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadMeshIntegrityReport

# Interface: GraphRoadMeshIntegrityReport

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:164

Summary report produced by `auditGraphRoadMeshIntegrity()`.

## Properties

### auditedMeshCount

> **auditedMeshCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:166

Total horizontal at-grade road/path/step/junction meshes inspected.

***

### auditedTriangleCount

> **auditedTriangleCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:168

Total indexed triangles inspected across all audited at-grade road/path/junction features.

***

### degenerateTriangles

> **degenerateTriangles**: [`GraphRoadDegenerateTriangleDefect`](GraphRoadDegenerateTriangleDefect.md)[]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:178

Degenerate triangles (`area <= 1e-6 m²`) reported separately from winding defects.

***

### negativelyWoundCount

> **negativelyWoundCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:172

Number of triangles with inverted/downward geometric winding (`geomNormal.y < 0`).

***

### storedNormalMismatchCount

> **storedNormalMismatchCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:174

Number of triangles whose stored vertex normals disagree with the geometric face normal (`dot <= 0.99`).

***

### upwardTriangleCount

> **upwardTriangleCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:170

Number of non-degenerate horizontal triangles with valid upward `+Y` geometric winding (`geomNormal.y > 0.99`).

***

### windingDefects

> **windingDefects**: [`GraphRoadWindingDefect`](GraphRoadWindingDefect.md)[]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:176

Winding and normal orientation defects with full feature and coordinate attribution.
