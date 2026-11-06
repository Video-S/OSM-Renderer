[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / parseInfrastructureRenderOptionsFromSearch

# Function: parseInfrastructureRenderOptionsFromSearch()

> **parseInfrastructureRenderOptionsFromSearch**(`search`): [`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:101

Parses independent `topologyRoads` and `topologyRailways` developer switches
from a URL query string (e.g. `?topologyRoads=graph-preview&topologyRailways=legacy`)
or `URLSearchParams` instance. Invalid or missing parameters resolve to `'legacy'`.

## Parameters

### search

`string` \| `URLSearchParams`

## Returns

[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)
