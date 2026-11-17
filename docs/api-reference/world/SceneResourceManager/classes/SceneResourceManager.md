[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/SceneResourceManager](../README.md) / SceneResourceManager

# Class: SceneResourceManager

Defined in: world/SceneResourceManager.ts:10

Explicit GPU Resource Manager ensuring single-pass, idempotent cleanup,
immediate disposal of intermediate geometries after buffer merging,
protection against duplicate disposal of shared materials, and lifecycle
management of BVH spatial acceleration structures (`three-mesh-bvh`).

## Constructors

### Constructor

> **new SceneResourceManager**(): `SceneResourceManager`

#### Returns

`SceneResourceManager`

## Accessors

### disposed

#### Get Signature

> **get** **disposed**(): `boolean`

Defined in: world/SceneResourceManager.ts:228

##### Returns

`boolean`

***

### disposedGeometriesCount

#### Get Signature

> **get** **disposedGeometriesCount**(): `number`

Defined in: world/SceneResourceManager.ts:142

##### Returns

`number`

***

### disposedMaterialsCount

#### Get Signature

> **get** **disposedMaterialsCount**(): `number`

Defined in: world/SceneResourceManager.ts:146

##### Returns

`number`

***

### ownedGeometriesCount

#### Get Signature

> **get** **ownedGeometriesCount**(): `number`

Defined in: world/SceneResourceManager.ts:134

##### Returns

`number`

***

### ownedMaterialsCount

#### Get Signature

> **get** **ownedMaterialsCount**(): `number`

Defined in: world/SceneResourceManager.ts:138

##### Returns

`number`

## Methods

### dispose()

> **dispose**(): `void`

Defined in: world/SceneResourceManager.ts:232

#### Returns

`void`

***

### enableGroupBvh()

> **enableGroupBvh**(`root`): `void`

Defined in: world/SceneResourceManager.ts:101

Recursively enables BVH-accelerated raycasting on all non-instanced `THREE.Mesh`
descendants of the given root object or group.

#### Parameters

##### root

`Object3D`\<`Object3DEventMap`\>

#### Returns

`void`

***

### enableMeshBvh()

> **enableMeshBvh**\<`T`\>(`mesh`): `T`

Defined in: world/SceneResourceManager.ts:54

Builds an indirect `MeshBVH` once for a static `THREE.Mesh` and attaches
`acceleratedRaycast` without mutating vertex attributes, index buffers, or `geometry.groups`.

- `{ indirect: true }` preserves original triangle indices (`0 .. triCount - 1`) so
  `faceIndex -> faceRanges -> InspectableFeatureInfo` binary search works unchanged on
  both indexed and non-indexed geometries.
- For single-material meshes (`!Array.isArray(mesh.material)`), `geometry.groups` is
  temporarily cleared during `MeshBVH` initialization and immediately restored so that
  `three-mesh-bvh` builds a single unified BVH covering 100% of triangles even when
  merged geometries combine grouped `ShapeGeometry` items with ungrouped ribbon buffers.

#### Type Parameters

##### T

`T` *extends* `Mesh`\<`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>, `Material`\<`MaterialEventMap`\> \| `Material`\<`MaterialEventMap`\>[], `Object3DEventMap`\>

#### Parameters

##### mesh

`T`

#### Returns

`T`

***

### getBvhMemoryStats()

> **getBvhMemoryStats**(): `object`

Defined in: world/SceneResourceManager.ts:190

Computes exact CPU memory (`byteLength`) used by `MeshBVH` acceleration structures
(`_roots` node buffers and `_indirectBuffer` triangle index maps) across all currently
owned BufferGeometries.

#### Returns

`object`

##### bvhCount

> **bvhCount**: `number`

##### indirectBufferBytes

> **indirectBufferBytes**: `number`

##### rootBytes

> **rootBytes**: `number`

##### totalBytes

> **totalBytes**: `number`

##### totalMB

> **totalMB**: `number`

***

### getCpuBufferMemoryStats()

> **getCpuBufferMemoryStats**(): `object`

Defined in: world/SceneResourceManager.ts:154

Computes exact CPU-side JavaScript TypedArray memory (`byteLength`) across all currently
owned BufferGeometries (summing vertex attributes and index buffers).

#### Returns

`object`

##### attributeBytes

> **attributeBytes**: `number`

##### geometryCount

> **geometryCount**: `number`

##### indexBytes

> **indexBytes**: `number`

##### totalBytes

> **totalBytes**: `number`

##### totalMB

> **totalMB**: `number`

***

### registerGeometry()

> **registerGeometry**\<`T`\>(`geo`): `T`

Defined in: world/SceneResourceManager.ts:21

#### Type Parameters

##### T

`T` *extends* `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

#### Parameters

##### geo

`T`

#### Returns

`T`

***

### registerMaterial()

> **registerMaterial**\<`T`\>(`mat`): `T`

Defined in: world/SceneResourceManager.ts:28

#### Type Parameters

##### T

`T` *extends* `Material`\<`MaterialEventMap`\>

#### Parameters

##### mat

`T`

#### Returns

`T`

***

### registerTexture()

> **registerTexture**\<`T`\>(`tex`): `T`

Defined in: world/SceneResourceManager.ts:35

#### Type Parameters

##### T

`T` *extends* `Texture`\<`unknown`, `TextureEventMap`\>

#### Parameters

##### tex

`T`

#### Returns

`T`

***

### releaseIntermediateGeometry()

> **releaseIntermediateGeometry**(`geo`): `void`

Defined in: world/SceneResourceManager.ts:122

Immediately disposes an intermediate geometry (e.g., an individual feature BufferGeometry
right after it has been merged into a batch BufferGeometry) and removes it from tracking.
Strictly single-pass and idempotent: repeated calls or calls on unowned geometries are safe no-ops.

#### Parameters

##### geo

`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

#### Returns

`void`
