[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / isConfirmedDuplicateSurface

# Function: isConfirmedDuplicateSurface()

> **isConfirmedDuplicateSurface**(`a`, `b`): `boolean`

Defined in: world/PlanarLayerValidator.ts:576

Symmetric Multi-Criteria Duplicate Detection (v5):
1. Identical (category, subtype) and no conflicting distinguishing metadata (name, ref, sport).
2. Symmetric difference area A_sym <= min(2.0 m², max(0.08 m², 0.04m * max(Perimeter(A), Perimeter(B)))).
3. Bidirectional segment-to-segment Hausdorff boundary distance <= 0.15 m.

## Parameters

### a

#### category

`string`

#### mp

[`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

#### name?

`string`

#### osmTags?

`Record`\<`string`, `unknown`\>

#### perimeter

`number`

#### subtype

`string`

### b

#### category

`string`

#### mp

[`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

#### name?

`string`

#### osmTags?

`Record`\<`string`, `unknown`\>

#### perimeter

`number`

#### subtype

`string`

## Returns

`boolean`
