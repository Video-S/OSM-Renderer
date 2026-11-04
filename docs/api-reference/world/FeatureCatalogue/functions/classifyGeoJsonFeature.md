[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/FeatureCatalogue](../README.md) / classifyGeoJsonFeature

# Function: classifyGeoJsonFeature()

> **classifyGeoJsonFeature**(`props`, `geometryType`): [`ClassificationResult`](../interfaces/ClassificationResult.md)

Defined in: world/FeatureCatalogue.ts:276

Classifies any raw GeoJSON feature into an explicit OSM Carto category with rich human-readable descriptions.
Strictly checks both OSM tags AND geometry type (LineString vs Point vs Polygon)
to prevent point infrastructure or overhead wires from being misclassified as 3D surface alignments.

## Parameters

### props

[`RawGeoJsonProperties`](../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

### geometryType

`string`

## Returns

[`ClassificationResult`](../interfaces/ClassificationResult.md)
