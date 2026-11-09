[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / DEPTH\_OFFSET\_CONFIG

# Variable: DEPTH\_OFFSET\_CONFIG

> `const` **DEPTH\_OFFSET\_CONFIG**: `object`

Defined in: world/ElevationPolicy.ts:216

Three.js material polygonOffset configurations.
Mutually exclusive ground-cover fills do not rely on polygonOffset against each other
because their 2D footprints are disjoint after Boolean subtraction.
Intentional decals and raised transportation overlays use selective negative depth bias
to guarantee multi-step separation even on 16-bit depth buffers at steep oblique tilts (72°).

## Type Declaration

### markings

> **markings**: `object`

#### markings.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### markings.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-3.2`

#### markings.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-3.2`

### parkingMarkings

> **parkingMarkings**: `object`

#### parkingMarkings.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### parkingMarkings.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-1.0`

#### parkingMarkings.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-1.0`

### parkingSpaces

> **parkingSpaces**: `object`

#### parkingSpaces.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### parkingSpaces.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-0.6`

#### parkingSpaces.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-0.6`

### parks

> **parks**: `object`

#### parks.polygonOffset

> **polygonOffset**: `boolean` = `false`

#### parks.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `0`

#### parks.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `0`

### paths

> **paths**: `object`

#### paths.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### paths.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-2.0`

#### paths.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-2.0`

### pavedLots

> **pavedLots**: `object`

#### pavedLots.polygonOffset

> **polygonOffset**: `boolean` = `false`

#### pavedLots.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `0`

#### pavedLots.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `0`

### pitchMarkings

> **pitchMarkings**: `object`

#### pitchMarkings.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### pitchMarkings.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-1.0`

#### pitchMarkings.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-1.0`

### railwayRails

> **railwayRails**: `object`

#### railwayRails.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### railwayRails.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-4.0`

#### railwayRails.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-4.0`

### railways

> **railways**: `object`

#### railways.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### railways.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-3.0`

#### railways.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-3.0`

### railwaySleepers

> **railwaySleepers**: `object`

#### railwaySleepers.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### railwaySleepers.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-3.5`

#### railwaySleepers.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-3.5`

### roads

> **roads**: `object`

#### roads.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### roads.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-2.5`

#### roads.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-2.5`

### subzoning

> **subzoning**: `object`

#### subzoning.polygonOffset

> **polygonOffset**: `boolean` = `false`

#### subzoning.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `0`

#### subzoning.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `0`

### water

> **water**: `object`

#### water.polygonOffset

> **polygonOffset**: `boolean` = `true`

#### water.polygonOffsetFactor

> **polygonOffsetFactor**: `number` = `-0.5`

#### water.polygonOffsetUnits

> **polygonOffsetUnits**: `number` = `-0.5`
