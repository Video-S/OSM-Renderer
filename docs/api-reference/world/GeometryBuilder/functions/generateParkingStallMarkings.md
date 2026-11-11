[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / generateParkingStallMarkings

# Function: generateParkingStallMarkings()

> **generateParkingStallMarkings**(`polygon`, `isIndividualSpace`, `yElev`, `existingSpaceBoxes`, `higherOverlappingMultiPolygon?`, `resolvedMultiPolygon?`): `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

Defined in: world/GeometryBuilder.ts:1375

Generates crisp painted parking stall lines for either an individual `amenity=parking_space` polygon
or a surface `amenity=parking` lot polygon (including resolved MultiPolygons with interior holes).
Eliminates T-junction collinear sweep-line failures by separating perpendicular stall dividers
from the spine edge by 2mm and merging contiguous spine runs into single stroke quads.

## Parameters

### polygon

\[`number`, `number`\][][]

### isIndividualSpace

`boolean`

### yElev

`number`

### existingSpaceBoxes

`object`[]

### higherOverlappingMultiPolygon?

[`MultiPolygonCoords`](../../PlanarLayerValidator/type-aliases/MultiPolygonCoords.md)

### resolvedMultiPolygon?

[`MultiPolygonCoords`](../../PlanarLayerValidator/type-aliases/MultiPolygonCoords.md)

## Returns

`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>
