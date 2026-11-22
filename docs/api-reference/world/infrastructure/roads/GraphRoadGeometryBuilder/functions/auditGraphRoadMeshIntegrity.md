[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / auditGraphRoadMeshIntegrity

# Function: auditGraphRoadMeshIntegrity()

> **auditGraphRoadMeshIntegrity**(`roadsRoot`): [`GraphRoadMeshIntegrityReport`](../interfaces/GraphRoadMeshIntegrityReport.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:212

Audits all horizontal at-grade road, path, step-tread, and junction triangles under `roadsRoot`
by computing actual geometric face normals from indexed triangle positions via `cross(v1 - v0, v2 - v0)`.

Verifies:
1. Every non-degenerate horizontal at-grade road/path/junction triangle faces upward (`geomNormal.y > 0.99`).
2. Stored vertex normals agree with geometric face orientation (`dot(storedNormal, geomNormal) > 0.99`).
3. Degenerate triangles (`area <= 1e-6 m²`) are reported separately.
4. Valid 3D structural meshes (`Bridge_Substructure`, `Bridge_Piers`, `Bridge_Parapets`, `Tunnel_Portals`)
   and sloped elevated bridge ramps are not misclassified as horizontal at-grade road surfaces.

## Parameters

### roadsRoot

`Object3D`

## Returns

[`GraphRoadMeshIntegrityReport`](../interfaces/GraphRoadMeshIntegrityReport.md)
