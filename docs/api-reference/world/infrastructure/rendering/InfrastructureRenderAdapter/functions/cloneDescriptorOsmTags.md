[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / cloneDescriptorOsmTags

# Function: cloneDescriptorOsmTags()

> **cloneDescriptorOsmTags**(`tags?`): [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:635

Recursively deep-clones JSON-compatible metadata (objects, arrays, primitives)
to ensure descriptor metadata is completely decoupled and isolated from
`InfrastructureGraph`, edge provenance, and source `ProcessedMapData`.

## Parameters

### tags?

[`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

## Returns

[`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)
