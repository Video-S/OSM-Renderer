[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / generateBridgeStructureGeometries

# Function: generateBridgeStructureGeometries()

> **generateBridgeStructureGeometries**(`profile`, `width`, `peakElevation`, `deckThickness?`, `options?`): `object`

Defined in: world/BridgeAndTunnelBuilder.ts:625

Generates 3D bridge deck substructure (side fascia walls, soffit underside, and solid ramp abutment walls
reaching down to ground level under the sloped approach ramps), plus side safety parapets and support piers.

## Parameters

### profile

[`ProfiledPoint3D`](../interfaces/ProfiledPoint3D.md)[]

### width

`number`

### peakElevation

`number`

### deckThickness?

`number` = `0.36`

### options?

[`BridgeStructureGenerationOptions`](../interfaces/BridgeStructureGenerationOptions.md)

## Returns

`object`

### parapetGeo

> **parapetGeo**: `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

### piersGeo

> **piersGeo**: `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

### substructureGeo

> **substructureGeo**: `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>
