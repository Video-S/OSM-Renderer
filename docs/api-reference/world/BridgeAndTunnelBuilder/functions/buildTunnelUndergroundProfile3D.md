[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / buildTunnelUndergroundProfile3D

# Function: buildTunnelUndergroundProfile3D()

> **buildTunnelUndergroundProfile3D**(`options`): `object`

Defined in: world/BridgeAndTunnelBuilder.ts:232

Constructs a continuous 3D vertical profile `ProfiledPoint3D[]` along a subterranean tunnel alignment (M2.3-E4-T).
- At justified external portal entrances (`emitStartPortal` / `emitEndPortal`), starts at `surfaceElevation`
  and slopes smoothly down through a short local entrance ramp (`min(10.0 m, 35% of span)`) to `targetTunnelElevation`
  (`ELEVATION_POLICY.TUNNEL_DEPTH = -2.0 m` for layer -1), staying strictly inside the mapped tunnel span.
- At internal multi-segment tunnel joints (`confirmed_elevated_continuation`), boundary-clipped ends
  (`boundary_clipped_continuation`), or unresolved ends (`unresolved_connection`), stays continuously at
  `targetTunnelElevation` with zero vertical step.

## Parameters

### options

[`TunnelUndergroundProfileOptions`](../interfaces/TunnelUndergroundProfileOptions.md)

## Returns

`object`

### maxElevation

> **maxElevation**: `number`

### minElevation

> **minElevation**: `number`

### profile

> **profile**: [`ProfiledPoint3D`](../interfaces/ProfiledPoint3D.md)[]

### rampEndLength

> **rampEndLength**: `number`

### rampStartLength

> **rampStartLength**: `number`
