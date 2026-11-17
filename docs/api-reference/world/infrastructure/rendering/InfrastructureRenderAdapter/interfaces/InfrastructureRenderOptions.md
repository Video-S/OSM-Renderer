[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / InfrastructureRenderOptions

# Interface: InfrastructureRenderOptions

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:68

Canonical infrastructure render configuration (`E2+` roads + `R+` railways) plus inspection overlays.

## Properties

### railwayBallastStrategy?

> `optional` **railwayBallastStrategy?**: `"surface-first"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:72

***

### railways

> **railways**: `"graph-R+"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:70

***

### railwaySwitchPolicy?

> `optional` **railwaySwitchPolicy?**: `"graph"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:71

***

### roads

> **roads**: `"graph-surface"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:69

***

### showHiddenUndergroundGeometry?

> `optional` **showHiddenUndergroundGeometry?**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:84

Optional inspection/cutaway toggle for buried subterranean corridor meshes
(`Tunnel_Underground_Roads`, `Tunnel_Underground_Railway_*`, `Tunnel_Underground_Barriers`).
Disabled (`false`) by default in M2.3-E4-T2 so normal surface viewing avoids unnecessary draw calls.

***

### showUndergroundTunnelTraces?

> `optional` **showUndergroundTunnelTraces?**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:78

Optional diagnostic overlay toggle for map-style dashed surface tunnel alignment traces
(`Tunnel_Underground_Trace` / `Railway_Tunnel_Traces`). Disabled (`false`) by default in M2.3-E4-T2
so tunnels convincingly disappear underground in physical 3D presentation.
