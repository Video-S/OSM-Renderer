# ADR-0004: Grade-Separated Infrastructure, Elevation Policy, and Bridge/Culvert Disambiguation

## Metadata

- **Decision ID**: `ADR-0004`
- **Status**: `Accepted`
- **Date**: `2026-10-27`
- **Deciders**: `Core Engineering Team`
- **Consulted**: `Geometry & Infrastructure Team`

---

## Context and Problem

Real-world urban environments feature complex vertical grade separation: elevated motorway flyovers, railway bridges, pedestrian footbridges over canals, and subterranean tunnels.

In earlier versions of the viewer, two critical problems occurred:
1. **Length-Based Bridge Classification Bug**: Any bridge shorter than $15\text{ m}$ was automatically classified as an at-grade culvert. This caused short, legitimate flyovers crossing local roads or canals to be forced down to ground level (`ROAD_SURFACE`), triggering z-fighting with the road or waterway below and merging with at-grade road junctions.
2. **Abrupt Vertical Discontinuities**: Bridges popped upward without approach ramps, creating floating road decks with open gaps under their ends.

---

## Decision

We establish an unambiguous **grade-separation and elevation model** implemented in `src/world/ElevationPolicy.ts` and `src/world/BridgeAndTunnelBuilder.ts`:

1. **Elevation Conventions**:
   - At-Grade Road Surface: `ROAD_SURFACE = 0.050 m`.
   - Elevated Bridge Decks: `ROAD_SURFACE + BRIDGE_BASE_CLEARANCE = 2.850 m` for layer 1 (`+1.4 m` per additional positive layer).
   - Subterranean Tunnels: `TUNNEL_DEPTH = -2.000 m` ($-1.0\text{ m}$ per negative layer).
2. **Proper Bridge vs. Culvert Disambiguation**:
   - Length alone is **never** used to demote a bridge to an at-grade culvert.
   - An at-grade culvert is strictly a narrow enclosed water channel (`waterway=stream|ditch|drain`) passing beneath an at-grade road.
   - Any feature tagged `bridge=yes` or `layer > 0` crossing another road, railway, or navigable canal maintains full elevated clearance (`2.850 m`).
3. **Approach Ramp Profiles (`buildBridgeProfile3D`)**:
   - Approach transition length: $\min(12.0\text{ m}, 30\% \text{ of span})$.
   - Central clearance fraction: At least $40\%$ (`MIN_CENTRAL_DECK_FRACTION = 0.40`) of the bridge deck remains flat at full clearance height over crossed features.
   - Short Bridge Fallback ($< 5.0\text{ m}$): Uses vertical abutment headwalls (`rampMode = 'abutment_headwall'`) at full `2.850 m` height rather than flattening the deck.
4. **Structural Realism**:
   - Concrete pier pillars touch ground level beneath spans.
   - Protective parapet railings rise `+0.85 m` along deck edges.
   - 3D tunnel entrance portals and dark recessed ramps cut into the ground at tunnel portals.

---

## Alternatives Considered

1. **Flat Elevated Slabs Without Ramps**:
   - *Pros*: Trivial to mesh.
   - *Cons*: Vehicles would drive off a 2.8-meter vertical cliff; visually broken.
2. **Arbitrary Micro-Tiering by Road Class**:
   - *Pros*: Separates primary from secondary roads.
   - *Cons*: Violates real-world physics; ordinary roads of different classes do not fly 30 cm above each other.

---

## Consequences and Trade-Offs

### Positive
- Visually compelling and physically grounded bridges and tunnels.
- Clean grade separation: Crossing ways do not intersect or z-fight.
- Complete preservation of bridge clearance regardless of bridge length.

### Negative / Neutral
- Mesh complexity: Requires multi-part geometry generation for ramps, piers, parapets, and portals.

---

## Related Source Modules

- `src/world/ElevationPolicy.ts`
- `src/world/BridgeAndTunnelBuilder.ts`
- `src/world/LocalGeoJsonProvider.ts`
- `src/world/GeometryBuilder.ts`

---

## Tests and Evidence

- `src/world/JunctionAndTopology.test.ts`:
  - `Grade-separated bridge crossing an at-grade road is NOT merged into at-grade junction`
  - `Short grade-separated bridge (< 15m) crossing a road or canal is NOT reclassified as an at-grade culvert`
  - `Bridge ramp profile transitions over min(12m, 30% of bridge length) as documented`
  - `Issue 2 Regression: Short bridges preserve full agreed targetBridgeElevation (2.850m) across all 5 bridge/culvert scenarios`

---

## Superseded or Related Decisions

- Supersedes the 15-meter length-based culvert heuristic.
- Related to `ADR-0002` (Road Junction Meshing).
