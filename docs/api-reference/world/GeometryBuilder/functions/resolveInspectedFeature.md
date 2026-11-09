[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / resolveInspectedFeature

# Function: resolveInspectedFeature()

> **resolveInspectedFeature**(`hit`): [`InspectableFeatureInfo`](../../../types/MapFeature/interfaces/InspectableFeatureInfo.md)

Defined in: world/GeometryBuilder.ts:213

Resolves any Three.js / React Three Fiber raycast intersection to its exact OpenStreetMap feature metadata.
Supports:
1. InstancedMesh hits via `instanceId` (3D forest trees, towers, point landmarks)
2. Merged BufferGeometry hits via `faceIndex` binary search (`faceRanges` on roads, railways, parks, landuse, water, barriers)
3. Individual mesh `userData` hits (buildings & custom structures)

## Parameters

### hit

#### faceIndex?

`number`

#### instanceId?

`number`

#### object?

`any`

## Returns

[`InspectableFeatureInfo`](../../../types/MapFeature/interfaces/InspectableFeatureInfo.md)
