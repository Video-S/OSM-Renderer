[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/WorldCoordinates](../README.md) / WGS84\_EQUATORIAL\_RADIUS

# Variable: WGS84\_EQUATORIAL\_RADIUS

> `const` **WGS84\_EQUATORIAL\_RADIUS**: `6378137` = `6378137.0`

Defined in: world/WorldCoordinates.ts:9

Coordinate projection module for converting geographic WGS84 coordinates (lon, lat)
to local Euclidean 3D space in meters (X = East, Y = Up, Z = South).

Designed with a clean interface so the underlying local Equirectangular / Transverse Mercator
projection can be swapped or augmented with web mercator / vector tile coordinates in the future.
