[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / buildBridgeProfile3D

# Function: buildBridgeProfile3D()

> **buildBridgeProfile3D**(`options`): `object`

Defined in: world/BridgeAndTunnelBuilder.ts:123

Densifies a 2D polyline and computes a smooth 3D vertical elevation profile `y(s)` for a bridge.
- Preserves full grade separation (`peakElevation = targetBridgeElevation`) regardless of bridge length.
- Computes ramp lengths from `mappedBridgeLength` (`min(12.0 m, 30% of mapped bridge length)`),
  before any synthetic external approach segments are appended for standalone bridges.
- Adapts ramp lengths and longitudinal sampling density on short bridges (`5.0 m <= L < 40.0 m`)
  so at least `40%` of the bridge span remains flat at full `targetBridgeElevation`.
- Uses the documented `'abutment_headwall'` fallback when `mappedBridgeLength < 5.0 m`.

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
