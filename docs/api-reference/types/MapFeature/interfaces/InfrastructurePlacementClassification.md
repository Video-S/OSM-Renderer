[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [types/MapFeature](../README.md) / InfrastructurePlacementClassification

# Interface: InfrastructurePlacementClassification

Defined in: world/InfrastructurePlacementClassifier.ts:72

Complete semantic placement classification record for an infrastructure way or edge (`M2.3-E4-T`).

## Properties

### canGenerateUndergroundGeometry

> **canGenerateUndergroundGeometry**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:106

True when continuous 3D underground road/railway geometry should be generated (`placement === 'underground_tunnel' && !hasConflict && !isCulvert`).

***

### confidence

> **confidence**: [`InfrastructurePlacementConfidence`](../type-aliases/InfrastructurePlacementConfidence.md)

Defined in: world/InfrastructurePlacementClassifier.ts:82

Confidence and provenance of the classification decision.

***

### conflictReason?

> `optional` **conflictReason?**: `"bridge_and_tunnel_both_tagged"` \| `"bridge_and_underground_location"` \| `"bridge_with_negative_layer"` \| `"tunnel_with_positive_layer"` \| `"tunnel_no_with_underground_location"` \| `"unrecognized_tunnel_value"`

Defined in: world/InfrastructurePlacementClassifier.ts:98

Machine-readable reason when `hasConflict === true`.

***

### enclosure

> **enclosure**: [`InfrastructureEnclosureKind`](../type-aliases/InfrastructureEnclosureKind.md)

Defined in: world/InfrastructurePlacementClassifier.ts:78

Physical overhead enclosure category.

***

### evidenceTags

> **evidenceTags**: readonly `string`[]

Defined in: world/InfrastructurePlacementClassifier.ts:110

Canonical list of OSM tag key=value pairs that contributed to this classification.

***

### hasConflict

> **hasConflict**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:96

True when vertical/enclosure tags are contradictory or use an unrecognized `tunnel=*` value.

***

### isCoveredPassage

> **isCoveredPassage**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:92

True when the way is covered at or above ground (`covered=*` or `tunnel=building_passage|avalanche_protector|covered|gallery`).

***

### isCulvert

> **isCulvert**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:90

True when the way is tagged as a culvert (`tunnel=culvert`, `culvert=yes`, `bridge=culvert`, `man_made=culvert`).

***

### isElevatedBridge

> **isElevatedBridge**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:88

True when the way is a confirmed non-conflicting elevated bridge/viaduct (`placement === 'elevated'`).

***

### isOpenCutting

> **isOpenCutting**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:94

True when the way runs in an open excavation (`cutting=*`).

***

### isSubterraneanTunnel

> **isSubterraneanTunnel**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:86

True ONLY when the way is a confirmed non-conflicting subterranean tunnel (`placement === 'underground_tunnel'`).

***

### layer

> **layer**: `number`

Defined in: world/InfrastructurePlacementClassifier.ts:84

Effective relative OSM `layer` integer (default `0`).

***

### placement

> **placement**: [`InfrastructurePlacementKind`](../type-aliases/InfrastructurePlacementKind.md)

Defined in: world/InfrastructurePlacementClassifier.ts:74

Primary placement category.

***

### rendersOnSurface

> **rendersOnSurface**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:108

True when the way should be rendered on the surface as at-grade/open/covered infrastructure rather than grade-separated.

***

### supportingEvidence

> **supportingEvidence**: [`InfrastructureSupportingVerticalEvidence`](InfrastructureSupportingVerticalEvidence.md)

Defined in: world/InfrastructurePlacementClassifier.ts:112

Optional supporting vertical tags (`incline=*`, `ele=*`, `level=*`, `maxheight=*`).

***

### tunnelSubtype

> **tunnelSubtype**: [`TunnelConstructionSubtype`](../type-aliases/TunnelConstructionSubtype.md)

Defined in: world/InfrastructurePlacementClassifier.ts:80

Specific tunnel or covered construction subtype.

***

### verticalRelation

> **verticalRelation**: [`InfrastructureVerticalRelation`](../type-aliases/InfrastructureVerticalRelation.md)

Defined in: world/InfrastructurePlacementClassifier.ts:76

Vertical relation relative to ground level (separating physical depth from relative OSM `layer`).
