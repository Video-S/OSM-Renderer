[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / classifyPlanarTier

# Function: classifyPlanarTier()

> **classifyPlanarTier**(`category`, `subtype`, `area`, `osmTags?`): `object`

Defined in: world/PlanarLayerValidator.ts:630

Classifies any surface polygon into its canonical SemanticSurfaceClass and rendering metadata.

## Parameters

### category

`"water"` \| `"park"` \| `"landuse"`

### subtype

`string`

### area

`number`

### osmTags?

`Record`\<`string`, `unknown`\>

## Returns

`object`

### band

> **band**: `"substrate"` \| `"above_water"`

### baseElevationY

> **baseElevationY**: `number`

### baseTier

> **baseTier**: `number`

### depthOffset

> **depthOffset**: `object`

#### depthOffset.polygonOffset?

> `optional` **polygonOffset?**: `boolean`

#### depthOffset.polygonOffsetFactor?

> `optional` **polygonOffsetFactor?**: `number`

#### depthOffset.polygonOffsetUnits?

> `optional` **polygonOffsetUnits?**: `number`

### hasSurfaceMarkings

> **hasSurfaceMarkings**: `boolean`

### renderOrder

> **renderOrder**: `number`

### semanticClass

> **semanticClass**: [`SemanticSurfaceClass`](../type-aliases/SemanticSurfaceClass.md)
