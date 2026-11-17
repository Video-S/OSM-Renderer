[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / parseInfrastructureRenderOptionsFromSearch

# Function: parseInfrastructureRenderOptionsFromSearch()

> **parseInfrastructureRenderOptionsFromSearch**(`search`): [`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:232

Parses optional inspection flags (`showUndergroundTunnelTraces`, `showHiddenUndergroundGeometry`)
from URL search parameters while always resolving render engines to canonical `E2+ / R+`.

## Parameters

### search

`string` \| `URLSearchParams`

## Returns

[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)
