[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [types/MapFeature](../README.md) / MapFeatureDiagnostics

# Interface: MapFeatureDiagnostics

Defined in: types/MapFeature.ts:434

## Properties

### byGeometryType

> **byGeometryType**: `object`

Defined in: types/MapFeature.ts:539

Source features breakdown by GeoJSON geometry type

#### GeometryCollection

> **GeometryCollection**: `number`

#### LineString

> **LineString**: `number`

#### MultiLineString

> **MultiLineString**: `number`

#### MultiPoint

> **MultiPoint**: `number`

#### MultiPolygon

> **MultiPolygon**: `number`

#### Point

> **Point**: `number`

#### Polygon

> **Polygon**: `number`

#### Unknown

> **Unknown**: `number`

***

### cartoSubtypesCount?

> `optional` **cartoSubtypesCount?**: `Record`\<`string`, `number`\>

Defined in: types/MapFeature.ts:514

Count of classified features by human-readable OSM Carto subtype

***

### clippingFailures?

> `optional` **clippingFailures?**: `object`

Defined in: types/MapFeature.ts:505

Boolean clipping failures recorded during surface or road/path resolution

#### count

> **count**: `number`

#### sampleIds

> **sampleIds**: `string`[]

***

### constructedMeshesCount

> **constructedMeshesCount**: `number`

Defined in: types/MapFeature.ts:444

5. Total discrete Three.js meshes constructed in the scene graph

***

### featureLineage?

> `optional` **featureLineage?**: `object`

Defined in: types/MapFeature.ts:529

Feature processing outcomes and lineage tracking

#### chainedFeaturesCount

> **chainedFeaturesCount**: `number`

#### chainedGroupsCount

> **chainedGroupsCount**: `number`

#### chainingMap

> **chainingMap**: `Record`\<`string`, `string`[]\>

#### deduplicatedCount

> **deduplicatedCount**: `number`

#### deduplicatedMap

> **deduplicatedMap**: `Record`\<`string`, `string`[]\>

#### retainedCount

> **retainedCount**: `number`

***

### featuresClippedByBoundary?

> `optional` **featuresClippedByBoundary?**: `object`

Defined in: types/MapFeature.ts:492

Features clipped or omitted at the loaded region boundary

#### clippedCount

> **clippedCount**: `number`

#### omittedOutsideCount

> **omittedOutsideCount**: `number`

#### sampleIds

> **sampleIds**: `string`[]

***

### featuresFullySubtracted?

> `optional` **featuresFullySubtracted?**: `object`

Defined in: types/MapFeature.ts:499

Features completely removed by Boolean surface/carriageway subtraction

#### count

> **count**: `number`

#### sampleIds

> **sampleIds**: `string`[]

***

### geometryPartsGenerated

> **geometryPartsGenerated**: `object`

Defined in: types/MapFeature.ts:476

3D geometry parts actually constructed in GeometryBuilder.buildScene()

#### byCategory

> **byCategory**: `object`

##### byCategory.barriers?

> `optional` **barriers?**: `number`

##### byCategory.buildings

> **buildings**: `number`

##### byCategory.landmarks?

> `optional` **landmarks?**: `number`

##### byCategory.landuse

> **landuse**: `number`

##### byCategory.linearWaterways

> **linearWaterways**: `number`

##### byCategory.parks

> **parks**: `number`

##### byCategory.railways

> **railways**: `number`

##### byCategory.roads

> **roads**: `number`

##### byCategory.waterBodies

> **waterBodies**: `number`

#### total

> **total**: `number`

***

### parsedByCategory

> **parsedByCategory**: `object`

Defined in: types/MapFeature.ts:447

Counts of source features classified by category

#### barriers?

> `optional` **barriers?**: `number`

#### buildings

> **buildings**: `number`

#### landmarks?

> `optional` **landmarks?**: `number`

#### landuse

> **landuse**: `number`

#### linearWaterways

> **linearWaterways**: `number`

#### parks

> **parks**: `number`

#### railways

> **railways**: `number`

#### roads

> **roads**: `number`

#### waterBodies

> **waterBodies**: `number`

***

### parsedFeatureParts?

> `optional` **parsedFeatureParts?**: `object`

Defined in: types/MapFeature.ts:460

Parsed feature parts extracted during GeoJSON parsing (before 3D mesh generation)

#### byCategory

> **byCategory**: `object`

##### byCategory.barriers?

> `optional` **barriers?**: `number`

##### byCategory.buildings

> **buildings**: `number`

##### byCategory.landmarks?

> `optional` **landmarks?**: `number`

##### byCategory.landuse

> **landuse**: `number`

##### byCategory.linearWaterways

> **linearWaterways**: `number`

##### byCategory.parks

> **parks**: `number`

##### byCategory.railways

> **railways**: `number`

##### byCategory.roads

> **roads**: `number`

##### byCategory.waterBodies

> **waterBodies**: `number`

#### total

> **total**: `number`

***

### placementDiagnostics?

> `optional` **placementDiagnostics?**: [`InfrastructurePlacementDiagnostics`](InfrastructurePlacementDiagnostics.md)

Defined in: types/MapFeature.ts:565

Semantic placement classification breakdown (Stage E4-T)

***

### planarValidation?

> `optional` **planarValidation?**: `object`

Defined in: types/MapFeature.ts:555

Post-build planar polygon layering & Z-fighting validation report

#### conflictsResolved

> **conflictsResolved**: `number`

#### isValid

> **isValid**: `boolean`

#### maxStackDepth

> **maxStackDepth**: `number`

#### minObservedSeparationMeters

> **minObservedSeparationMeters**: `number`

#### overlappingPairsChecked

> **overlappingPairsChecked**: `number`

#### totalPolygons

> **totalPolygons**: `number`

***

### railwayRendererFallback?

> `optional` **railwayRendererFallback?**: `string`

Defined in: types/MapFeature.ts:511

Observable railway renderer fallback reason when graph mode falls back to legacy (Stage E3-A1)

***

### rejectedInvalid

> **rejectedInvalid**: `object`

Defined in: types/MapFeature.ts:523

Features rejected due to malformed or degenerate coordinates

#### byReason

> **byReason**: `Record`\<`string`, [`FeatureDiagnosticBreakdown`](FeatureDiagnosticBreakdown.md)\>

#### total

> **total**: `number`

***

### skippedUnsupported

> **skippedUnsupported**: `object`

Defined in: types/MapFeature.ts:517

Features skipped due to unsupported tags or non-linear infrastructure

#### byTag

> **byTag**: `Record`\<`string`, [`FeatureDiagnosticBreakdown`](FeatureDiagnosticBreakdown.md)\>

#### total

> **total**: `number`

***

### sourceFeaturesClassified

> **sourceFeaturesClassified**: `number`

Defined in: types/MapFeature.ts:438

2. Total source GeoJSON features successfully classified into a supported category

***

### sourceFeaturesReceived

> **sourceFeaturesReceived**: `number`

Defined in: types/MapFeature.ts:436

1. Total raw GeoJSON Feature objects received from source data

***

### sourceFeaturesRendered

> **sourceFeaturesRendered**: `number`

Defined in: types/MapFeature.ts:442

4. Total source features represented in the final 3D scene

***

### totalFeaturesParsed

> **totalFeaturesParsed**: `number`

Defined in: types/MapFeature.ts:440

3. Total source features whose geometry was valid and yielded parsed features

***

### totalFeaturesReceived

> **totalFeaturesReceived**: `number`

Defined in: types/MapFeature.ts:551

***

### totalFeaturesRendered

> **totalFeaturesRendered**: `number`

Defined in: types/MapFeature.ts:552
