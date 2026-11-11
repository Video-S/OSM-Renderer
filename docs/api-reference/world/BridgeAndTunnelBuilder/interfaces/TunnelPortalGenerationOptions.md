[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / TunnelPortalGenerationOptions

# Interface: TunnelPortalGenerationOptions

Defined in: world/BridgeAndTunnelBuilder.ts:200

## Properties

### emitEndPortal?

> `optional` **emitEndPortal?**: `boolean`

Defined in: world/BridgeAndTunnelBuilder.ts:202

***

### emitStartPortal?

> `optional` **emitStartPortal?**: `boolean`

Defined in: world/BridgeAndTunnelBuilder.ts:201

***

### maxheightMeters?

> `optional` **maxheightMeters?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:204

Optional explicit maxheight in meters (`maxheight=*`) to scale portal vertical clearance (M2.3-E4-T).

***

### railwayType?

> `optional` **railwayType?**: `string`

Defined in: world/BridgeAndTunnelBuilder.ts:206

Optional railway type (`'rail'`, `'subway'`, `'light_rail'`, `'tram'`) for railway portal scaling (M2.3-E4-T).

***

### surfaceElevation?

> `optional` **surfaceElevation?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:208

Surface base elevation at portal entrance (defaults to `ELEVATION_POLICY.ROAD_SURFACE = 0.050`).
