[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / resolveAndValidatePlanarPolygons

# Function: resolveAndValidatePlanarPolygons()

> **resolveAndValidatePlanarPolygons**(`landuse`, `parks`, `waterBodies?`, `linearWaterways?`): `object`

Defined in: world/PlanarLayerValidator.ts:930

Resolves all planar surface polygons (`landuse`, `parks`, and `waterBodies`/`linearWaterways`)
using the v5 4-Stage Semantic Surface Resolution Engine:
1. Ring conditioning & duplicate / unnamed same-subtype fragment union.
2. Exhaustive, antisymmetric pairwise ownership classification (`resolvePairwiseOutcome`).
3. Order-independent batch MultiPolygon Boolean subtraction: P_final = P \ Union(R(P)).
4. Uniform flush ground-cover plane assignment (+0.025m) & post-resolution invariant verification.

## Parameters

### landuse

[`LanduseFeature`](../../../types/MapFeature/interfaces/LanduseFeature.md)[]

### parks

[`ParkFeature`](../../../types/MapFeature/interfaces/ParkFeature.md)[]

### waterBodies?

[`WaterBodyFeature`](../../../types/MapFeature/interfaces/WaterBodyFeature.md)[] = `[]`

### linearWaterways?

[`LinearWaterwayFeature`](../../../types/MapFeature/interfaces/LinearWaterwayFeature.md)[] = `[]`

## Returns

`object`

### report

> **report**: [`PlanarValidationReport`](../interfaces/PlanarValidationReport.md)

### resolvedById

> **resolvedById**: `Map`\<`string`, [`ResolvedPlanarLayer`](../interfaces/ResolvedPlanarLayer.md)\>
