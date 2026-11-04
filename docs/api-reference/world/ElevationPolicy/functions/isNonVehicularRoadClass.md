[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / isNonVehicularRoadClass

# Function: isNonVehicularRoadClass()

> **isNonVehicularRoadClass**(`roadClass`): `boolean`

Defined in: world/ElevationPolicy.ts:116

Helper to determine if a RoadClass belongs to the non-vehicular path/pedestrian category.
Used for semantic categorization, width rules, and 2D carriageway clipping priority
(NOT for assigning a different physical elevation).

## Parameters

### roadClass

[`RoadClass`](../../../types/MapFeature/type-aliases/RoadClass.md)

## Returns

`boolean`
