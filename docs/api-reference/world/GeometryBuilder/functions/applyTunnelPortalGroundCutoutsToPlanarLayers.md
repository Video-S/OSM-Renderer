[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / applyTunnelPortalGroundCutoutsToPlanarLayers

# Function: applyTunnelPortalGroundCutoutsToPlanarLayers()

> **applyTunnelPortalGroundCutoutsToPlanarLayers**(`data`, `resolvedPlanarById`, `tunnelEntrances`, `roadWidthMultiplier?`): `void`

Defined in: world/GeometryBuilder.ts:1938

Applies localized portal entrance cutouts to overlapping landuse/park ground-cover polygons.
Shared between global study ingestion and single-scene GeometryBuilder builds.

## Parameters

### data

[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)

### resolvedPlanarById

`Map`\<`string`, [`ResolvedPlanarLayer`](../../PlanarLayerValidator/interfaces/ResolvedPlanarLayer.md)\>

### tunnelEntrances

`VerifiedTunnelEntrances`

### roadWidthMultiplier?

`number` = `1.0`

## Returns

`void`
