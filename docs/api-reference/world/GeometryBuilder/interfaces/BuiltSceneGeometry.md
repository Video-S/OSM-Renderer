[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / BuiltSceneGeometry

# Interface: BuiltSceneGeometry

Defined in: world/GeometryBuilder.ts:187

## Properties

### barriersGroup

> **barriersGroup**: `Group`

Defined in: world/GeometryBuilder.ts:194

***

### buildingsGroup

> **buildingsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:188

***

### dispose

> **dispose**: () => `void`

Defined in: world/GeometryBuilder.ts:210

#### Returns

`void`

***

### foliageGroup

> **foliageGroup**: `Group`

Defined in: world/GeometryBuilder.ts:195

***

### groundMesh

> **groundMesh**: `Mesh`

Defined in: world/GeometryBuilder.ts:196

***

### infrastructureRenderOptions

> **infrastructureRenderOptions**: [`InfrastructureRenderOptions`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderOptions.md)

Defined in: world/GeometryBuilder.ts:208

***

### infrastructureRenderPreview

> **infrastructureRenderPreview**: [`InfrastructureRenderPreviewResult`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderPreviewResult.md)

Defined in: world/GeometryBuilder.ts:209

***

### interactiveMeshes

> **interactiveMeshes**: `object`

Defined in: world/GeometryBuilder.ts:197

#### buildings

> **buildings**: `Mesh`\<`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>, `Material`\<`MaterialEventMap`\> \| `Material`\<`MaterialEventMap`\>[], `Object3DEventMap`\>[]

***

### landuseGroup

> **landuseGroup**: `Group`

Defined in: world/GeometryBuilder.ts:193

***

### parksGroup

> **parksGroup**: `Group`

Defined in: world/GeometryBuilder.ts:192

***

### railwaysGroup

> **railwaysGroup**: `Group`

Defined in: world/GeometryBuilder.ts:190

***

### resources

> **resources**: [`SceneResourceManager`](../../SceneResourceManager/classes/SceneResourceManager.md)

Defined in: world/GeometryBuilder.ts:207

***

### roadsGroup

> **roadsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:189

***

### stats

> **stats**: `object`

Defined in: world/GeometryBuilder.ts:200

#### forestTreesCount?

> `optional` **forestTreesCount?**: `number`

#### renderedFeaturesCount

> **renderedFeaturesCount**: `number`

#### totalDrawCalls

> **totalDrawCalls**: `number`

#### totalTriangles

> **totalTriangles**: `number`

#### totalVertices

> **totalVertices**: `number`

***

### updateCameraZoom?

> `optional` **updateCameraZoom?**: (`zoom`) => `void`

Defined in: world/GeometryBuilder.ts:212

#### Parameters

##### zoom

`number`

#### Returns

`void`

***

### updateTheme

> **updateTheme**: (`theme`) => `void`

Defined in: world/GeometryBuilder.ts:211

#### Parameters

##### theme

[`MapStyleTheme`](../../../types/MapFeature/interfaces/MapStyleTheme.md)

#### Returns

`void`

***

### waterGroup

> **waterGroup**: `Group`

Defined in: world/GeometryBuilder.ts:191
