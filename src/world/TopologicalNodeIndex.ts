/**
 * ============================================================================
 * TOPOLOGICAL NODE INDEX & COORDINATE SNAPPING
 * ============================================================================
 *
 * Clusters metric world coordinates [x, z] into canonical topological nodes
 * while preserving explicit OpenStreetMap node identifiers when available.
 *
 * Snapping Tolerance Justification (0.15 meters / 15 cm):
 * - Standard 7-decimal-place WGS84 GeoJSON coordinates have ~1.1 cm metric precision.
 *   When two connected ways share an endpoint in GeoJSON without explicit node IDs,
 *   their projected local [x, z] coordinates agree to within < 0.02 m.
 * - Distinct parallel roadways, dual carriageways, and adjacent sidewalks/cycleways
 *   in OpenStreetMap are separated by >= 1.5 m to 3.5 m.
 * - Therefore, a 0.15 m (15 cm) snapping tolerance reliably unifies shared topological
 *   endpoints while guaranteeing that nearby parallel roads are never accidentally merged.
 * - Grade-separation scoping (`layerScope`) further guarantees that bridges (`layer > 0`
 *   or `isBridge = true`) and tunnels (`layer < 0` or `isTunnel = true`) crossing an
 *   at-grade road at identical [x, z] coordinates are never merged into at-grade junctions.
 */

export const DEFAULT_NODE_SNAP_TOLERANCE_METERS = 0.15;

export class TopologicalNodeIndex {
  private grid = new Map<
    string,
    Array<{ id: string; x: number; z: number; scope: string; isExplicit: boolean }>
  >();
  private explicitOsmNodes = new Map<string, { id: string; x: number; z: number; scope: string }>();
  private fallbackToExplicitAlias = new Map<string, string>();
  private nodePositions = new Map<string, [number, number]>();
  private nodeCounter = 0;
  readonly snapTolerance: number;

  constructor(snapTolerance: number = DEFAULT_NODE_SNAP_TOLERANCE_METERS) {
    this.snapTolerance = snapTolerance;
  }

  private cellKey(gx: number, gz: number, scope: string): string {
    return `${scope}|${gx},${gz}`;
  }

  /**
   * Resolves a canonical node ID if a fallback coordinate node was later promoted to an explicit OSM node.
   */
  resolveCanonicalNodeId(nodeId: string): string {
    let cur = nodeId;
    const visited = new Set<string>();
    while (this.fallbackToExplicitAlias.has(cur) && !visited.has(cur)) {
      visited.add(cur);
      cur = this.fallbackToExplicitAlias.get(cur)!;
    }
    return cur;
  }

  /**
   * Resolves a canonical node ID for a point [x, z].
   * - If an explicit OSM node ID is provided, preserves that identifier (scoped by `layerScope`),
   *   and indexes its spatial position in `this.grid` so subsequent coordinate-only ways at the same
   *   location in the same `layerScope` resolve to the same node ID.
   * - If an unnamed coordinate-fallback node was already created within `snapTolerance` in the same
   *   `layerScope` before this explicit OSM node arrived, promotes that fallback node entry to `osmKey`
   *   and records an alias in `fallbackToExplicitAlias`.
   * - Two distinct explicit OSM node IDs are NEVER merged together even if within `snapTolerance`.
   * - If no explicit OSM node ID is provided, performs a spatial hash lookup within `snapTolerance` (0.15m)
   *   inside the same `layerScope` across both explicit and fallback nodes.
   */
  getOrCreateNode(
    x: number,
    z: number,
    layerScope: string = '0|false|false',
    explicitOsmNodeId?: string | number | null
  ): string {
    const cellSize = Math.max(this.snapTolerance, 1e-3);
    const gx = Math.floor(x / cellSize);
    const gz = Math.floor(z / cellSize);

    if (
      explicitOsmNodeId !== undefined &&
      explicitOsmNodeId !== null &&
      String(explicitOsmNodeId).trim() !== ''
    ) {
      const rawIdStr = String(explicitOsmNodeId).trim();
      const cleanIdPart = rawIdStr.includes('|osm_')
        ? rawIdStr.split('|osm_').pop()!
        : rawIdStr.startsWith('osm_')
          ? rawIdStr.slice(4)
          : rawIdStr;
      const osmKey = `${layerScope}|osm_${cleanIdPart}`;
      const existing = this.explicitOsmNodes.get(osmKey);
      if (existing) {
        return existing.id;
      }
      this.explicitOsmNodes.set(osmKey, { id: osmKey, x, z, scope: layerScope });
      this.nodePositions.set(osmKey, [x, z]);

      // Check if an unnamed coordinate-fallback node was already created at this location in the same scope
      let promotedFallback = false;
      for (let dx = -1; dx <= 1 && !promotedFallback; dx++) {
        for (let dz = -1; dz <= 1 && !promotedFallback; dz++) {
          const key = this.cellKey(gx + dx, gz + dz, layerScope);
          const cell = this.grid.get(key);
          if (!cell) continue;
          for (const node of cell) {
            if (node.isExplicit) continue;
            if (Math.hypot(node.x - x, node.z - z) <= this.snapTolerance) {
              this.fallbackToExplicitAlias.set(node.id, osmKey);
              node.id = osmKey;
              node.isExplicit = true;
              node.x = x;
              node.z = z;
              promotedFallback = true;
              break;
            }
          }
        }
      }

      if (!promotedFallback) {
        const key = this.cellKey(gx, gz, layerScope);
        let cell = this.grid.get(key);
        if (!cell) {
          cell = [];
          this.grid.set(key, cell);
        }
        cell.push({ id: osmKey, x, z, scope: layerScope, isExplicit: true });
      }
      return osmKey;
    }

    let bestNodeId: string | null = null;
    let bestDist = this.snapTolerance;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = this.cellKey(gx + dx, gz + dz, layerScope);
        const cell = this.grid.get(key);
        if (cell) {
          for (const node of cell) {
            const dist = Math.hypot(node.x - x, node.z - z);
            if (dist <= bestDist) {
              bestDist = dist;
              bestNodeId = node.id;
            }
          }
        }
      }
    }

    if (bestNodeId) {
      return this.resolveCanonicalNodeId(bestNodeId);
    }

    this.nodeCounter++;
    const id =
      layerScope === '0|false|false'
        ? `tn_${this.nodeCounter}`
        : `tn_${layerScope}_${this.nodeCounter}`;
    const key = this.cellKey(gx, gz, layerScope);
    let cell = this.grid.get(key);
    if (!cell) {
      cell = [];
      this.grid.set(key, cell);
    }
    cell.push({ id, x, z, scope: layerScope, isExplicit: false });
    this.nodePositions.set(id, [x, z]);
    return id;
  }

  /**
   * Resolves an array of node IDs for a polyline, preserving per-vertex OSM node IDs
   * when available in the source feature properties and falling back to spatial snapping.
   */
  resolveWayNodeIds(
    points: [number, number][],
    layerScope: string = '0|false|false',
    rawOsmNodeIds?: Array<string | number> | null
  ): string[] {
    const hasValidOsmIds =
      Array.isArray(rawOsmNodeIds) && rawOsmNodeIds.length === points.length;

    return points.map((pt, idx) =>
      this.getOrCreateNode(
        pt[0],
        pt[1],
        layerScope,
        hasValidOsmIds ? rawOsmNodeIds![idx] : undefined
      )
    );
  }

  getNodePosition(nodeId: string): [number, number] | undefined {
    const canonical = this.resolveCanonicalNodeId(nodeId);
    return this.nodePositions.get(canonical) ?? this.nodePositions.get(nodeId);
  }
}
