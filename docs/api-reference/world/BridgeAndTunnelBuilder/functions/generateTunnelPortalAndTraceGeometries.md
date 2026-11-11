[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / generateTunnelPortalAndTraceGeometries

# Function: generateTunnelPortalAndTraceGeometries()

> **generateTunnelPortalAndTraceGeometries**(`points`, `width`, `isPedestrianOrCycle?`, `options?`): `object`

Defined in: world/BridgeAndTunnelBuilder.ts:1083

Generates 3D tunnel portal headwall arches, dark recessed portal entrance mouths,
and a dashed underground corridor trace for a subterranean road, path, or railway tunnel.
All vertices are kept at Y >= ELEVATION_POLICY.GROUND_COVER_SURFACE (>= 0.025m)
so surface mesh invariants (y >= 0) and depth-buffer tests are strictly satisfied.

## Parameters

### points

\[`number`, `number`\][]

### width

`number`

### isPedestrianOrCycle?

`boolean` = `false`

### options?

[`TunnelPortalGenerationOptions`](../interfaces/TunnelPortalGenerationOptions.md)

## Returns

`object`

### portalMouthGeo

> **portalMouthGeo**: `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

### portalStructureGeo

> **portalStructureGeo**: `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

### undergroundTraceGeo

> **undergroundTraceGeo**: `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>
