[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / resolveTunnelClearanceAndDepth

# Function: resolveTunnelClearanceAndDepth()

> **resolveTunnelClearanceAndDepth**(`options`): [`ResolvedTunnelClearance`](../interfaces/ResolvedTunnelClearance.md)

Defined in: world/ElevationPolicy.ts:148

Centralizes subterranean tunnel clearance and floor depth calculations (M2.3-E4-T2).

- Ensures every subterranean tunnel leaves sufficient vertical clearance plus structural roof cover
  beneath `Y = 0.0 m` (`targetFloorElevation + requiredClearanceMeters <= -roofCoverThicknessMeters`).
- Respects explicit OSM `maxheight=*` tags when present.
- Distinguishes pedestrian/cycleway underpasses, vehicular roads, urban transit / non-electrified rail,
  and electrified mainline rail.

## Parameters

### options

[`TunnelClearanceOptions`](../interfaces/TunnelClearanceOptions.md)

## Returns

[`ResolvedTunnelClearance`](../interfaces/ResolvedTunnelClearance.md)
