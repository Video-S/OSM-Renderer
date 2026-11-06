[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / createShapesFromMultiPolygon

# Function: createShapesFromMultiPolygon()

> **createShapesFromMultiPolygon**(`mp`): `Shape`[]

Defined in: world/GeometryBuilder.ts:640

Converts a resolved MultiPolygon (which may contain disconnected outer polygons and interior holes)
into an array of winding-normalized THREE.Shape instances.

## Parameters

### mp

[`MultiPolygonCoords`](../../PlanarLayerValidator/type-aliases/MultiPolygonCoords.md)

## Returns

`Shape`[]
