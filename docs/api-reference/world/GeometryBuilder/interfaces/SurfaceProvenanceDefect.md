[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / SurfaceProvenanceDefect

# Interface: SurfaceProvenanceDefect

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:172

Provenance attribution defect detected during A4 validation.

## Properties

### description

> **description**: `string`

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:186

***

### featureId?

> `optional` **featureId?**: `string`

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:184

***

### kind

> **kind**: `"unattributed_triangle_face"` \| `"missing_source_feature_id"` \| `"unknown_source_feature_id"` \| `"road_class_mismatch"` \| `"osm_tag_mismatch"` \| `"provenance_span_escape"` \| `"deduplicated_lineage_missing"` \| `"invalid_fully_subtracted_claim"` \| `"diagnostics_fully_subtracted_desync"`

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:173

***

### meshName?

> `optional` **meshName?**: `string`

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:183

***

### sourceFeatureId?

> `optional` **sourceFeatureId?**: `string`

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:185
