[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / validateAndPruneHorizontalGeometry

# Function: validateAndPruneHorizontalGeometry()

> **validateAndPruneHorizontalGeometry**(`geo`): `boolean`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:907

Validates and cleans a horizontal road/path/step/junction `BufferGeometry` in place:
- Rejects all visibly inverted triangles (`geomNormal.y <= 0.99`) rather than reversing indices.
  Tiny near-collinear triangles with altitude below Float32 coordinate spacing are
  pruned instead, because their winding cannot be represented reliably.
- Filters out zero-area collinear sliver triangles (`area <= 1e-6 m²`) emitted by earcut or pinched quads.
- Ensures stored vertex normals on all active vertices are `[0, 1, 0]`.

Returns `true` if at least one valid upward-facing triangle remains and
no resolvably inverted triangles exist; otherwise returns `false`.

## Parameters

### geo

`BufferGeometry`

## Returns

`boolean`
