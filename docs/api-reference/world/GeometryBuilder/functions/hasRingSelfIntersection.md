[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / hasRingSelfIntersection

# Function: hasRingSelfIntersection()

> **hasRingSelfIntersection**(`ring`): `boolean`

Defined in: world/GeometryBuilder.ts:776

Checks whether a closed 2D polygon ring `[x, z][]` contains any proper non-adjacent edge self-intersections
or zero-width fold-back reversals that would corrupt sweep-line Boolean clipping or create overlapping triangles.

## Parameters

### ring

\[`number`, `number`\][]

## Returns

`boolean`
