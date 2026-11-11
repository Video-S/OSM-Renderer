[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / buildBridgeProfile3D

# Function: buildBridgeProfile3D()

> **buildBridgeProfile3D**(`options`): `object`

Defined in: world/BridgeAndTunnelBuilder.ts:358

Densifies a 2D polyline and computes a smooth 3D vertical elevation profile `y(s)` for a bridge.
- Preserves full grade separation (`peakElevation = targetBridgeElevation`) regardless of bridge length.
- Computes ramp lengths from `mappedBridgeLength` (`min(12.0 m, 30% of mapped bridge length)`),
  before any synthetic external approach segments are appended for standalone bridges in legacy mode.
- When Stage E4-A graph classifications (`startClassification` / `endClassification`) are provided:
  - Never invents synthetic external approach extensions for standalone, unresolved, or boundary-clipped ends.
  - Ramps to `baseElevation` strictly at `'confirmed_transition'` portals (and along multi-edge connected bridge
    components via `startPortalDistanceMeters`, `endPortalDistanceMeters`, and `componentRampLengthMeters`).
  - Preserves elevated deck height conservatively at `'boundary_clipped_continuation'`, `'unresolved_connection'`,
    and `'intentionally_standalone'` endpoints.

## Parameters

### options

[`BridgeProfileOptions`](../interfaces/BridgeProfileOptions.md)

## Returns

`object`

### mappedBridgeLength

> **mappedBridgeLength**: `number`

### peakElevation

> **peakElevation**: `number`

### profile

> **profile**: [`ProfiledPoint3D`](../interfaces/ProfiledPoint3D.md)[]

### rampEndLength

> **rampEndLength**: `number`

### rampMode

> **rampMode**: [`BridgeRampMode`](../type-aliases/BridgeRampMode.md)

### rampStartLength

> **rampStartLength**: `number`
