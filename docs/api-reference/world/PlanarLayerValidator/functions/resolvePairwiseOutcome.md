[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / resolvePairwiseOutcome

# Function: resolvePairwiseOutcome()

> **resolvePairwiseOutcome**(`a`, `b`, `aContainedInB`, `bContainedInA`, `isDuplicateOrLogicalUnion?`): [`PairwiseOwnershipOutcome`](../type-aliases/PairwiseOwnershipOutcome.md)

Defined in: world/PlanarLayerValidator.ts:748

Exhaustive, Antisymmetric Pairwise Ownership Policy (v5):
Given two intersecting surface features A and B and their geometric containment flags
(`aContainedInB`, `bContainedInA`), returns the unique ownership outcome:
- 'INTENTIONAL_OVERLAY' (for parking_space decals)
- 'UNION' (for confirmed duplicates or unnamed same-subtype logical fragments)
- 'A_REPLACES_B' (A owns the intersection; B subtracts A)
- 'B_REPLACES_A' (B owns the intersection; A subtracts B)

Guaranteed antisymmetric: if outcome(A, B) === 'A_REPLACES_B', then outcome(B, A) === 'B_REPLACES_A'.

## Parameters

### a

#### area

`number`

#### category

`"water"` \| `"park"` \| `"landuse"`

#### id

`string`

#### isDuplicate?

`boolean`

#### name?

`string`

#### semanticClass

[`SemanticSurfaceClass`](../type-aliases/SemanticSurfaceClass.md)

#### subtype

`string`

### b

#### area

`number`

#### category

`"water"` \| `"park"` \| `"landuse"`

#### id

`string`

#### isDuplicate?

`boolean`

#### name?

`string`

#### semanticClass

[`SemanticSurfaceClass`](../type-aliases/SemanticSurfaceClass.md)

#### subtype

`string`

### aContainedInB

`boolean`

### bContainedInA

`boolean`

### isDuplicateOrLogicalUnion?

`boolean` = `false`

## Returns

[`PairwiseOwnershipOutcome`](../type-aliases/PairwiseOwnershipOutcome.md)
