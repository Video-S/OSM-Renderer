[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [types/MapFeature](../README.md) / ProcessedMapData

# Interface: ProcessedMapData

Defined in: types/MapFeature.ts:541

## Properties

### barriers

> **barriers**: [`BarrierFeature`](BarrierFeature.md)[]

Defined in: types/MapFeature.ts:561

***

### bounds

> **bounds**: `object`

Defined in: types/MapFeature.ts:544

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

Defined in: types/MapFeature.ts:552

***

### centerLonLat

> **centerLonLat**: \[`number`, `number`\]

Defined in: types/MapFeature.ts:543

***

### diagnostics

> **diagnostics**: [`MapFeatureDiagnostics`](MapFeatureDiagnostics.md)

Defined in: types/MapFeature.ts:565

***

### landmarks

> **landmarks**: [`PointLandmarkFeature`](PointLandmarkFeature.md)[]

Defined in: types/MapFeature.ts:562

***

### landuse

> **landuse**: [`LanduseFeature`](LanduseFeature.md)[]

Defined in: types/MapFeature.ts:560

***

### linearWaterways

> **linearWaterways**: [`LinearWaterwayFeature`](LinearWaterwayFeature.md)[]

Defined in: types/MapFeature.ts:556

***

### parks

> **parks**: [`ParkFeature`](ParkFeature.md)[]

Defined in: types/MapFeature.ts:559

***

### railways

> **railways**: [`RailwayFeature`](RailwayFeature.md)[]

Defined in: types/MapFeature.ts:554

***

### regionName

> **regionName**: `string`

Defined in: types/MapFeature.ts:542

***

### roads

> **roads**: [`RoadFeature`](RoadFeature.md)[]

Defined in: types/MapFeature.ts:553

***

### stats

> **stats**: `object`

Defined in: types/MapFeature.ts:566

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

### topologySource?

> `optional` **topologySource?**: [`TopologySourceData`](../../../world/infrastructure/topology/types/interfaces/TopologySourceData.md)

Defined in: types/MapFeature.ts:564

Non-destructive pre-deduplication and pre-chaining topology inputs (ADR-0009).

***

### water

> **water**: [`WaterBodyFeature`](WaterBodyFeature.md)[]

Defined in: types/MapFeature.ts:558

***

### waterBodies

> **waterBodies**: [`WaterBodyFeature`](WaterBodyFeature.md)[]

Defined in: types/MapFeature.ts:555
