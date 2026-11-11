[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / InfrastructurePointMetadata

# Interface: InfrastructurePointMetadata

Defined in: world/infrastructure/topology/types.ts:68

Point-level OSM infrastructure node metadata preserved during GeoJSON ingestion (populated in Stage D).

## Properties

### hasExplicitSourceId

> **hasExplicitSourceId**: `boolean`

Defined in: world/infrastructure/topology/types.ts:72

True if `id` came from an explicit source feature ID (`f.id`, `props.id`, or `props['@id']`), false if synthetic `feat-${featureIndex}`.

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:70

Feature ID from GeoJSON (e.g. "node/98765").

***

### kind

> **kind**: [`InfrastructurePointKind`](../type-aliases/InfrastructurePointKind.md)

Defined in: world/infrastructure/topology/types.ts:78

Classified point infrastructure role.

***

### osmTags

> **osmTags**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/topology/types.ts:80

Original raw OSM tags on the point feature (`crossing=*`, `railway:switch=*`, `turnout_side=*`, etc.).

***

### point

> **point**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:76

Local metric world coordinates [x, z].

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/topology/types.ts:74

Explicit raw OSM node ID if extractable (e.g. "98765"), otherwise undefined.
