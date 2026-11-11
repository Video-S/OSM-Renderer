[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / InfrastructureRenderOptions

# Interface: InfrastructureRenderOptions

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:96

Independent developer configuration switches for road and railway topology-to-renderer modes.

## Properties

### railwayBallastStrategy?

> `optional` **railwayBallastStrategy?**: [`RailwayBallastStrategy`](../type-aliases/RailwayBallastStrategy.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:100

***

### railways

> **railways**: [`RailwayInfrastructureRenderSource`](../type-aliases/RailwayInfrastructureRenderSource.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:98

***

### railwaySwitchPolicy?

> `optional` **railwaySwitchPolicy?**: [`RailwaySwitchPolicy`](../type-aliases/RailwaySwitchPolicy.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:99

***

### roads

> **roads**: [`RoadInfrastructureRenderSource`](../type-aliases/RoadInfrastructureRenderSource.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:97

***

### showHiddenUndergroundGeometry?

> `optional` **showHiddenUndergroundGeometry?**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:112

Optional inspection/cutaway toggle for buried subterranean corridor meshes
(`Tunnel_Underground_Roads`, `Tunnel_Underground_Railway_*`, `Tunnel_Underground_Barriers`).
Disabled (`false`) by default in M2.3-E4-T2 so normal surface viewing avoids unnecessary draw calls.

***

### showUndergroundTunnelTraces?

> `optional` **showUndergroundTunnelTraces?**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:106

Optional diagnostic overlay toggle for map-style dashed surface tunnel alignment traces
(`Tunnel_Underground_Trace` / `Railway_Tunnel_Traces`). Disabled (`false`) by default in M2.3-E4-T2
so tunnels convincingly disappear underground in physical 3D presentation.
