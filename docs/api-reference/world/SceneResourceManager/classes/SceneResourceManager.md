[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/SceneResourceManager](../README.md) / SceneResourceManager

# Class: SceneResourceManager

Defined in: world/SceneResourceManager.ts:8

Explicit GPU Resource Manager ensuring single-pass, idempotent cleanup,
immediate disposal of intermediate geometries after buffer merging,
and protection against duplicate disposal of shared materials.

## Constructors

### Constructor

> **new SceneResourceManager**(): `SceneResourceManager`

#### Returns

`SceneResourceManager`

## Accessors

### disposed

#### Get Signature

> **get** **disposed**(): `boolean`

Defined in: world/SceneResourceManager.ts:107

##### Returns

`boolean`

***

### disposedGeometriesCount

#### Get Signature

> **get** **disposedGeometriesCount**(): `number`

Defined in: world/SceneResourceManager.ts:64

##### Returns

`number`

***

### disposedMaterialsCount

#### Get Signature

> **get** **disposedMaterialsCount**(): `number`

Defined in: world/SceneResourceManager.ts:68

##### Returns

`number`

***

### ownedGeometriesCount

#### Get Signature

> **get** **ownedGeometriesCount**(): `number`

Defined in: world/SceneResourceManager.ts:56

##### Returns

`number`

***

### ownedMaterialsCount

#### Get Signature

> **get** **ownedMaterialsCount**(): `number`

Defined in: world/SceneResourceManager.ts:60

##### Returns

`number`

## Methods

### dispose()

> **dispose**(): `void`

Defined in: world/SceneResourceManager.ts:111

#### Returns

`void`

***

### getCpuBufferMemoryStats()

> **getCpuBufferMemoryStats**(): `object`

Defined in: world/SceneResourceManager.ts:76

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

Defined in: world/SceneResourceManager.ts:19

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

Defined in: world/SceneResourceManager.ts:26

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

Defined in: world/SceneResourceManager.ts:33

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

Defined in: world/SceneResourceManager.ts:45

Immediately disposes an intermediate geometry (e.g., an individual feature BufferGeometry
right after it has been merged into a batch BufferGeometry) and removes it from tracking.
Strictly single-pass and idempotent: repeated calls or calls on unowned geometries are safe no-ops.

#### Parameters

##### geo

`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

#### Returns

`void`
