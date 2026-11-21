[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / mergeBuildingItemsByMaterial

# Function: mergeBuildingItemsByMaterial()

> **mergeBuildingItemsByMaterial**(`items`, `resourceManager?`): `object`

Defined in: world/GeometryBuilder.ts:837

Consolidates a bucket of building geometries by `materialIndex` so each building bucket mesh
emits at most one contiguous `BufferGeometry` group (and therefore one WebGL draw call per pass)
per used material slot (e.g. `[0 = roof/cap, 1 = walls/bevels/pillars]`) instead of interleaving
2–3 groups per individual building (`O(buildings)` draw calls).

Non-building layers continue to use `mergeWithFaceRanges` unchanged.

## Parameters

### items

`object`[]

### resourceManager?

[`SceneResourceManager`](../../SceneResourceManager/classes/SceneResourceManager.md)

## Returns

`object`

### faceRanges

> **faceRanges**: [`FaceFeatureRange`](../interfaces/FaceFeatureRange.md)[]

### merged

> **merged**: `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>
