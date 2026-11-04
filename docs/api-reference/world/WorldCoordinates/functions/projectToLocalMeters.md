[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/WorldCoordinates](../README.md) / projectToLocalMeters

# Function: projectToLocalMeters()

> **projectToLocalMeters**(`lon`, `lat`, `originLon`, `originLat`): \[`number`, `number`\]

Defined in: world/WorldCoordinates.ts:25

Projects (lon, lat) in degrees into local Cartesian (x, z) coordinates in meters
relative to an origin (originLon, originLat).
- X axis points East (+X)
- Z axis points South (+Z), so North is (-Z)
- Y axis represents vertical elevation

## Parameters

### lon

`number`

### lat

`number`

### originLon

`number`

### originLat

`number`

## Returns

\[`number`, `number`\]
