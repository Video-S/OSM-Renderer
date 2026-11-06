[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / createShapeFromRings

# Function: createShapeFromRings()

> **createShapeFromRings**(`rings`): `Shape`

Defined in: world/GeometryBuilder.ts:593

Creates a THREE.Shape from polygon rings (outer ring + holes) in the XZ plane.
Normalizes outer ring to counter-clockwise (CCW) and hole rings to clockwise (CW)
in Three.js 2D Shape space (x, -z) so earcut triangulation never inverts or drops holes.

## Parameters

### rings

\[`number`, `number`\][][]

## Returns

`Shape`
