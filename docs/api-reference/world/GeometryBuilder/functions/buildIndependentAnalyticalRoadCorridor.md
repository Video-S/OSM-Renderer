[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / buildIndependentAnalyticalRoadCorridor

# Function: buildIndependentAnalyticalRoadCorridor()

> **buildIndependentAnalyticalRoadCorridor**(`points`, `width`, `options`): [`MultiPolygonCoords`](../../PlanarLayerValidator/type-aliases/MultiPolygonCoords.md)

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:250

Independently constructs a 2D analytical corridor MultiPolygon from a polyline and width
using 24-sided endpoint/bend disks (distinct from E2+'s 16-sided snapped buffer) for
non-circular area and point-coverage verification.

## Parameters

### points

readonly (readonly \[`number`, `number`\])[]

### width

`number`

### options

#### capEnd

`boolean`

#### capStart

`boolean`

## Returns

[`MultiPolygonCoords`](../../PlanarLayerValidator/type-aliases/MultiPolygonCoords.md)
