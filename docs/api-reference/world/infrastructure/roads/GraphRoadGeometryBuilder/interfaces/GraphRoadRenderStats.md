[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadRenderStats

# Interface: GraphRoadRenderStats

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:418

Diagnostic and benchmark counters emitted by the Stage E2 graph-driven road geometry builder.

## Properties

### atGradeRoadEdgeCount

> **atGradeRoadEdgeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:424

Number of road edge descriptors eligible for at-grade ribbon construction (`isAtGradeBuildable`).

***

### branchingJunctionCount

> **branchingJunctionCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:430

Number of vehicular branching junctions (`requiresVehicularJunctionTrimming === true`) meshed.

***

### crossTierOnlyNodeCount

> **crossTierOnlyNodeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:436

Number of cross-tier-only interaction nodes (`isCrossTierOnlyInteraction === true`) encountered.

***

### degree2ContinuityJoinCount

> **degree2ContinuityJoinCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:432

Number of degree-2 continuity joins (`requiresVehicularContinuityMiter === true` or path degree-2) resolved.

***

### fullySubtractedCount

> **fullySubtractedCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:440

Number of road/path edges or sub-segments completely removed by 2D Boolean carriageway subtraction.

***

### inputRoadEdgeCount

> **inputRoadEdgeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:422

Total road edge descriptors in the input adapter bundle.

***

### inputRoadNodeCount

> **inputRoadNodeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:420

Total road node descriptors in the input adapter bundle.

***

### pathJunctionCount

> **pathJunctionCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:434

Number of pure path-tier branching junctions (`requiresPathJunctionTrimming === true`, `>= 3` arms) meshed.

***

### provenanceSplitSegmentCount

> **provenanceSplitSegmentCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:442

Number of additional sub-segments produced by splitting simplified edges at provenance boundaries.

***

### rejectedOrDegenerateCount

> **rejectedOrDegenerateCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:438

Number of degenerate or micro road edges/sub-segments or invalid junction solutions rejected.

***

### renderedJunctionCount

> **renderedJunctionCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:428

Total rendered junction polygon geometry items emitted (vehicular + path junctions).

***

### renderedRoadRibbonCount

> **renderedRoadRibbonCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:426

Total rendered at-grade road/path ribbon geometry items emitted (including provenance sub-segments).
