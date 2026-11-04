[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [types/MapFeature](../README.md) / MapFeatureDiagnostics

# Interface: MapFeatureDiagnostics

Defined in: types/MapFeature.ts:392

## Properties

### byGeometryType

> **byGeometryType**: `object`

Defined in: types/MapFeature.ts:494

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

Defined in: types/MapFeature.ts:469

Count of classified features by human-readable OSM Carto subtype

***

### clippingFailures?

> `optional` **clippingFailures?**: `object`

Defined in: types/MapFeature.ts:463

Boolean clipping failures recorded during surface or road/path resolution

#### count

> **count**: `number`

#### sampleIds

> **sampleIds**: `string`[]

***

### constructedMeshesCount

> **constructedMeshesCount**: `number`

Defined in: types/MapFeature.ts:402

5. Total discrete Three.js meshes constructed in the scene graph

***

### featureLineage?

> `optional` **featureLineage?**: `object`

Defined in: types/MapFeature.ts:484

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

Defined in: types/MapFeature.ts:450

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

Defined in: types/MapFeature.ts:457

Features completely removed by Boolean surface/carriageway subtraction

#### count

> **count**: `number`

#### sampleIds

> **sampleIds**: `string`[]

***

### geometryPartsGenerated

> **geometryPartsGenerated**: `object`

Defined in: types/MapFeature.ts:434

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

Defined in: types/MapFeature.ts:405

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

Defined in: types/MapFeature.ts:418

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

### planarValidation?

> `optional` **planarValidation?**: `object`

Defined in: types/MapFeature.ts:510

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

### rejectedInvalid

> **rejectedInvalid**: `object`

Defined in: types/MapFeature.ts:478

Features rejected due to malformed or degenerate coordinates

#### byReason

> **byReason**: `Record`\<`string`, [`FeatureDiagnosticBreakdown`](FeatureDiagnosticBreakdown.md)\>

#### total

> **total**: `number`

***

### skippedUnsupported

> **skippedUnsupported**: `object`

Defined in: types/MapFeature.ts:472

Features skipped due to unsupported tags or non-linear infrastructure

#### byTag

> **byTag**: `Record`\<`string`, [`FeatureDiagnosticBreakdown`](FeatureDiagnosticBreakdown.md)\>

#### total

> **total**: `number`

***

### sourceFeaturesClassified

> **sourceFeaturesClassified**: `number`

Defined in: types/MapFeature.ts:396

2. Total source GeoJSON features successfully classified into a supported category

***

### sourceFeaturesReceived

> **sourceFeaturesReceived**: `number`

Defined in: types/MapFeature.ts:394

1. Total raw GeoJSON Feature objects received from source data

***

### sourceFeaturesRendered

> **sourceFeaturesRendered**: `number`

Defined in: types/MapFeature.ts:400

4. Total source features represented in the final 3D scene

***

### totalFeaturesParsed

> **totalFeaturesParsed**: `number`

Defined in: types/MapFeature.ts:398

3. Total source features whose geometry was valid and yielded parsed features

***

### totalFeaturesReceived

> **totalFeaturesReceived**: `number`

Defined in: types/MapFeature.ts:506

***

### totalFeaturesRendered

> **totalFeaturesRendered**: `number`

Defined in: types/MapFeature.ts:507
