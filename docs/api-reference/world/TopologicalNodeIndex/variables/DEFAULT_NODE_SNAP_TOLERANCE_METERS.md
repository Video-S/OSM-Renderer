[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/TopologicalNodeIndex](../README.md) / DEFAULT\_NODE\_SNAP\_TOLERANCE\_METERS

# Variable: DEFAULT\_NODE\_SNAP\_TOLERANCE\_METERS

> `const` **DEFAULT\_NODE\_SNAP\_TOLERANCE\_METERS**: `0.15` = `0.15`

Defined in: world/TopologicalNodeIndex.ts:22

============================================================================
TOPOLOGICAL NODE INDEX & COORDINATE SNAPPING
============================================================================

Clusters metric world coordinates [x, z] into canonical topological nodes
while preserving explicit OpenStreetMap node identifiers when available.

Snapping Tolerance Justification (0.15 meters / 15 cm):
- Standard 7-decimal-place WGS84 GeoJSON coordinates have ~1.1 cm metric precision.
  When two connected ways share an endpoint in GeoJSON without explicit node IDs,
  their projected local [x, z] coordinates agree to within < 0.02 m.
- Distinct parallel roadways, dual carriageways, and adjacent sidewalks/cycleways
  in OpenStreetMap are separated by >= 1.5 m to 3.5 m.
- Therefore, a 0.15 m (15 cm) snapping tolerance reliably unifies shared topological
  endpoints while guaranteeing that nearby parallel roads are never accidentally merged.
- Grade-separation scoping (`layerScope`) further guarantees that bridges (`layer > 0`
  or `isBridge = true`) and tunnels (`layer < 0` or `isTunnel = true`) crossing an
  at-grade road at identical [x, z] coordinates are never merged into at-grade junctions.
