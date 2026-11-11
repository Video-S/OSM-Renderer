[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / buildTunnelUndergroundProfile3D

# Function: buildTunnelUndergroundProfile3D()

> **buildTunnelUndergroundProfile3D**(`options`): `object`

Defined in: world/BridgeAndTunnelBuilder.ts:243

Constructs a continuous 3D vertical profile `ProfiledPoint3D[]` along a subterranean tunnel alignment (M2.3-E4-T / E4-T2).
- At justified external portal entrances (`emitStartPortal` / `emitEndPortal`), starts at `surfaceElevation`
  and drops below `ELEVATION_POLICY.GROUND` (`-0.08 m`) within the portal hood (`<= 2.2 m`) before sloping
  smoothly down through a local entrance ramp (`min(10.0 m, 35% of span)`) to `targetTunnelElevation`
  (`ELEVATION_POLICY.TUNNEL_DEPTH = -4.2 m` for layer -1), staying strictly inside the mapped tunnel span.
- At internal multi-segment tunnel joints (`confirmed_elevated_continuation`), boundary-clipped ends
  (`boundary_clipped_continuation`), or unresolved ends (`unresolved_connection`), stays continuously at
  `startTargetTunnelElevation` / `endTargetTunnelElevation` with zero vertical step.

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
