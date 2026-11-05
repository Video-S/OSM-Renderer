[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/OsmNodeIdEnricher](../README.md) / COORD\_ALIGNMENT\_TOLERANCE\_DEG

# Variable: COORD\_ALIGNMENT\_TOLERANCE\_DEG

> `const` **COORD\_ALIGNMENT\_TOLERANCE\_DEG**: `1e-7` = `1e-7`

Defined in: world/infrastructure/topology/OsmNodeIdEnricher.ts:16

Pure, deterministic helpers that enrich GeoJSON FeatureCollections produced by `osmtogeojson`
with verified per-vertex OSM node IDs (`properties._nodeIds` / `properties._nodeIdsByPart`)
from raw Overpass JSON (`way.nodes`) or OSM 0.6 XML (`<nd ref="...">`).

Node IDs are attached ONLY when both way identity AND 1:1 per-vertex coordinate alignment
against the source OSM node table are verified.
/**
Maximum coordinate alignment deviation between source OSM node table coordinates
and osmtogeojson LineString coordinates (degrees).

1e-7 degrees corresponds to ~1.11 cm at the equator and ~0.69 cm at mid-latitudes,
matching standard OSM 7-decimal-place precision and floating-point IEEE 754 fidelity,
and strictly tighter than the 15 cm (0.15 m) topology snap tolerance.
