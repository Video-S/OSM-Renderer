[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / BuiltSceneGeometry

# Interface: BuiltSceneGeometry

Defined in: world/GeometryBuilder.ts:255

## Properties

### barriersGroup

> **barriersGroup**: `Group`

Defined in: world/GeometryBuilder.ts:262

***

### buildingsGroup

> **buildingsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:256

***

### dispose

> **dispose**: () => `void`

Defined in: world/GeometryBuilder.ts:279

#### Returns

`void`

***

### foliageGroup

> **foliageGroup**: `Group`

Defined in: world/GeometryBuilder.ts:263

***

### groundMesh

> **groundMesh**: `Mesh`

Defined in: world/GeometryBuilder.ts:264

***

### infrastructureRenderOptions

> **infrastructureRenderOptions**: [`InfrastructureRenderOptions`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderOptions.md)

Defined in: world/GeometryBuilder.ts:277

***

### infrastructureRenderPreview

> **infrastructureRenderPreview**: [`InfrastructureRenderPreviewResult`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderPreviewResult.md)

Defined in: world/GeometryBuilder.ts:278

***

### interactiveMeshes

> **interactiveMeshes**: `object`

Defined in: world/GeometryBuilder.ts:265

#### buildings

> **buildings**: `Mesh`\<`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>, `Material`\<`MaterialEventMap`\> \| `Material`\<`MaterialEventMap`\>[], `Object3DEventMap`\>[]

***

### landuseGroup

> **landuseGroup**: `Group`

Defined in: world/GeometryBuilder.ts:261

***

### parksGroup

> **parksGroup**: `Group`

Defined in: world/GeometryBuilder.ts:260

***

### railwaysGroup

> **railwaysGroup**: `Group`

Defined in: world/GeometryBuilder.ts:258

***

### resources

> **resources**: [`SceneResourceManager`](../../SceneResourceManager/classes/SceneResourceManager.md)

Defined in: world/GeometryBuilder.ts:276

***

### roadsGroup

> **roadsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:257

***

### stageTimingsMs?

> `optional` **stageTimingsMs?**: [`SceneBuildStageTimingsMs`](SceneBuildStageTimingsMs.md)

Defined in: world/GeometryBuilder.ts:275

***

### stats

> **stats**: `object`

Defined in: world/GeometryBuilder.ts:268

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

Defined in: world/GeometryBuilder.ts:281

#### Parameters

##### zoom

`number`

#### Returns

`void`

***

### updateTheme

> **updateTheme**: (`theme`) => `void`

Defined in: world/GeometryBuilder.ts:280

#### Parameters

##### theme

[`MapStyleTheme`](../../../types/MapFeature/interfaces/MapStyleTheme.md)

#### Returns

`void`

***

### waterGroup

> **waterGroup**: `Group`

Defined in: world/GeometryBuilder.ts:259
