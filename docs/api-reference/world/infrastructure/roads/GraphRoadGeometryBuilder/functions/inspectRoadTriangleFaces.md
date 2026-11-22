[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / inspectRoadTriangleFaces

# Function: inspectRoadTriangleFaces()

> **inspectRoadTriangleFaces**(`geo`, `maxProblemFaces?`): [`RoadTriangleFailureAudit`](../interfaces/RoadTriangleFailureAudit.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:561

Source-filtered diagnostic mirroring validateAndPruneHorizontalGeometry.
In particular, an inverted face discarded as an unresolvable Float32
sliver must NOT be reported as the reason an entire road was rejected.

## Parameters

### geo

`BufferGeometry`

### maxProblemFaces?

`number` = `24`

## Returns

[`RoadTriangleFailureAudit`](../interfaces/RoadTriangleFailureAudit.md)
