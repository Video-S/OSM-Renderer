[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/FeatureCatalogue](../README.md) / classifyInfrastructurePlacement

# Function: classifyInfrastructurePlacement()

> **classifyInfrastructurePlacement**(`props?`, `hints?`): [`InfrastructurePlacementClassification`](../../../types/MapFeature/interfaces/InfrastructurePlacementClassification.md)

Defined in: world/InfrastructurePlacementClassifier.ts:329

Classifies the physical placement, vertical relation, and enclosure of an OSM feature
from its raw tags (`props`) and optional synthetic hints (`hints`).

Strictly separates relative OSM `layer` ordering (`layer < 0`) and surface coverings
(`covered=*`, `tunnel=building_passage`, `cutting=*`) from genuine subterranean tunnels (`underground_tunnel`).

## Parameters

### props?

[`RawGeoJsonProperties`](../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

### hints?

[`ExplicitPlacementHints`](../../../types/MapFeature/interfaces/ExplicitPlacementHints.md)

## Returns

[`InfrastructurePlacementClassification`](../../../types/MapFeature/interfaces/InfrastructurePlacementClassification.md)
