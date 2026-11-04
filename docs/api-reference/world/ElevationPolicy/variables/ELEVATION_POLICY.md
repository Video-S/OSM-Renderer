[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / ELEVATION\_POLICY

# Variable: ELEVATION\_POLICY

> `const` **ELEVATION\_POLICY**: `object`

Defined in: world/ElevationPolicy.ts:39

============================================================================
CENTRAL MAP SURFACE ELEVATION & GRADE-SEPARATION POLICY
============================================================================

Architectural Principles:
1. Separation of 2D Semantic Ownership and 3D Physical Elevation:
   - Mutually exclusive at-grade ground-cover fills (landuse, subzoning, parks,
     forests, grass islands, paved parking lots, sports pitches) are resolved in 2D
     via batch MultiPolygon Boolean subtraction so their footprints never overlap.
   - Because their 2D footprints are mutually exclusive, all resolved ground-cover fills
     share a SINGLE flush ground-cover plane (`GROUND_COVER_SURFACE = +0.025m`),
     producing a 0.0mm flush seam at every shared boundary.
2. Water Bodies & Waterways:
   - Surface water carves its footprint out of overlapping ground-cover polygons
     and sits at `WATER_SURFACE = +0.015m` (a 10mm depressed shoreline inside its cutout).
3. Intentional Surface Decals (`Parking_Markings`, `Pitch_Markings`, `parking_space`):
   - Placed relative to their host surface (`+0.028m` / `+0.029m`) with non-overlapping
     unioned 2D stroke geometry and selective `polygonOffset`.
4. Uniform At-Grade Road Baseline (`ROAD_SURFACE = +0.050m`):
   - All ordinary at-grade roads, streets, and pedestrian/cycle paths share the agreed
     uniform physical elevation baseline of `+0.050m` (`ROAD_SURFACE = 0.050`).
   - Ordinary roads of different classes (`primary`, `residential`, `footway`, `cycleway`)
     do NOT receive arbitrary physical elevation tiers or feature-ID micro-offsets.
   - Coplanar overlaps at intersections and cross-class crossings are eliminated in 2D
     via topological junction trimming and Boolean polygon clipping, supplemented by
     deterministic `renderOrder` and `polygonOffset`.
5. At-Grade Railway System (`+0.060m` to `+0.085m`):
   - Crushed stone ballast sits at `+0.060m` (10mm proud of `ROAD_SURFACE`),
     perpendicular cross-tie sleepers at `+0.072m`, and twin steel rails at `+0.085m`.
6. Real Grade Separation (Bridges & Tunnels):
   - Bridges rise to `ROAD_SURFACE + BRIDGE_BASE_CLEARANCE` (`+2.850m` for layer 1)
     via continuous sloped approach ramps and abutments.
   - Tunnels descend below grade (`TUNNEL_DEPTH = -2.0m`) through 3D tunnel portals.

## Type Declaration

### BRIDGE\_BASE\_CLEARANCE

> **BRIDGE\_BASE\_CLEARANCE**: `number` = `2.8`

### BRIDGE\_LAYER\_STEP

> **BRIDGE\_LAYER\_STEP**: `number` = `1.4`

### GROUND

> **GROUND**: `number` = `-0.015`

### GROUND\_COVER\_SURFACE

> **GROUND\_COVER\_SURFACE**: `number` = `0.025`

### LANDUSE

> **LANDUSE**: `number` = `-0.005`

### LANDUSE\_SUBZONING

> **LANDUSE\_SUBZONING**: `number` = `0.025`

### MARKING\_OFFSET

> **MARKING\_OFFSET**: `number` = `0.004`

### MAX\_MICRO\_TIERS

> **MAX\_MICRO\_TIERS**: `number` = `1`

### MICRO\_TIER\_STEP

> **MICRO\_TIER\_STEP**: `number` = `0.0`

### PARKING\_MARKINGS

> **PARKING\_MARKINGS**: `number` = `0.029`

### PARKING\_SPACE\_SURFACE

> **PARKING\_SPACE\_SURFACE**: `number` = `0.028`

### PARKS

> **PARKS**: `number` = `0.025`

### PAVED\_LOT\_SURFACE

> **PAVED\_LOT\_SURFACE**: `number` = `0.025`

### PITCH\_MARKINGS

> **PITCH\_MARKINGS**: `number` = `0.029`

### PITCH\_SURFACE

> **PITCH\_SURFACE**: `number` = `0.025`

### RAILWAY\_BALLAST

> **RAILWAY\_BALLAST**: `number` = `0.060`

### RAILWAY\_RAILS

> **RAILWAY\_RAILS**: `number` = `0.085`

### RAILWAY\_SLEEPERS

> **RAILWAY\_SLEEPERS**: `number` = `0.072`

### ROAD\_BASE\_TIERS

> **ROAD\_BASE\_TIERS**: `Record`\<[`RoadClass`](../../../types/MapFeature/type-aliases/RoadClass.md), `number`\>

### ROAD\_SURFACE

> **ROAD\_SURFACE**: `number` = `0.050`

### STEP\_TREAD\_OFFSET

> **STEP\_TREAD\_OFFSET**: `number` = `0.006`

### TUNNEL\_DEPTH

> **TUNNEL\_DEPTH**: `number` = `-2.0`

### TUNNEL\_LAYER\_STEP

> **TUNNEL\_LAYER\_STEP**: `number` = `1.0`

### WATER\_BOTTOM

> **WATER\_BOTTOM**: `number` = `-0.040`

### WATER\_SURFACE

> **WATER\_SURFACE**: `number` = `0.015`
