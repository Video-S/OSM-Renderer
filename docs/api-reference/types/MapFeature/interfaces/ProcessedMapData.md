[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [types/MapFeature](../README.md) / ProcessedMapData

# Interface: ProcessedMapData

Defined in: types/MapFeature.ts:520

## Properties

### barriers

> **barriers**: [`BarrierFeature`](BarrierFeature.md)[]

Defined in: types/MapFeature.ts:540

***

### bounds

> **bounds**: `object`

Defined in: types/MapFeature.ts:523

#### depthMeters

> **depthMeters**: `number`

#### maxX

> **maxX**: `number`

#### maxZ

> **maxZ**: `number`

#### minX

> **minX**: `number`

#### minZ

> **minZ**: `number`

#### widthMeters

> **widthMeters**: `number`

***

### buildings

> **buildings**: [`BuildingFeature`](BuildingFeature.md)[]

Defined in: types/MapFeature.ts:531

***

### centerLonLat

> **centerLonLat**: \[`number`, `number`\]

Defined in: types/MapFeature.ts:522

***

### diagnostics

> **diagnostics**: [`MapFeatureDiagnostics`](MapFeatureDiagnostics.md)

Defined in: types/MapFeature.ts:542

***

### landmarks

> **landmarks**: [`PointLandmarkFeature`](PointLandmarkFeature.md)[]

Defined in: types/MapFeature.ts:541

***

### landuse

> **landuse**: [`LanduseFeature`](LanduseFeature.md)[]

Defined in: types/MapFeature.ts:539

***

### linearWaterways

> **linearWaterways**: [`LinearWaterwayFeature`](LinearWaterwayFeature.md)[]

Defined in: types/MapFeature.ts:535

***

### parks

> **parks**: [`ParkFeature`](ParkFeature.md)[]

Defined in: types/MapFeature.ts:538

***

### railways

> **railways**: [`RailwayFeature`](RailwayFeature.md)[]

Defined in: types/MapFeature.ts:533

***

### regionName

> **regionName**: `string`

Defined in: types/MapFeature.ts:521

***

### roads

> **roads**: [`RoadFeature`](RoadFeature.md)[]

Defined in: types/MapFeature.ts:532

***

### stats

> **stats**: `object`

Defined in: types/MapFeature.ts:543

#### areaKm2

> **areaKm2**: `number`

#### totalBarriers?

> `optional` **totalBarriers?**: `number`

#### totalBuildings

> **totalBuildings**: `number`

#### totalLandmarks?

> `optional` **totalLandmarks?**: `number`

#### totalLandusePolygons

> **totalLandusePolygons**: `number`

#### totalLinearWaterways

> **totalLinearWaterways**: `number`

#### totalParkPolygons

> **totalParkPolygons**: `number`

#### totalRailways

> **totalRailways**: `number`

#### totalRailwaySegments

> **totalRailwaySegments**: `number`

#### totalRoads

> **totalRoads**: `number`

#### totalRoadSegments

> **totalRoadSegments**: `number`

#### totalWaterPolygons

> **totalWaterPolygons**: `number`

***

### water

> **water**: [`WaterBodyFeature`](WaterBodyFeature.md)[]

Defined in: types/MapFeature.ts:537

***

### waterBodies

> **waterBodies**: [`WaterBodyFeature`](WaterBodyFeature.md)[]

Defined in: types/MapFeature.ts:534
