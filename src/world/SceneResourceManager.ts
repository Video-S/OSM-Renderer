import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

/**
 * Explicit GPU Resource Manager ensuring single-pass, idempotent cleanup,
 * immediate disposal of intermediate geometries after buffer merging,
 * protection against duplicate disposal of shared materials, and lifecycle
 * management of BVH spatial acceleration structures (`three-mesh-bvh`).
 */
export class SceneResourceManager {
  private ownedGeometries = new Set<THREE.BufferGeometry>();
  private ownedMaterials = new Set<THREE.Material>();
  private ownedTextures = new Set<THREE.Texture>();
  private disposedGeometries = new WeakSet<THREE.BufferGeometry>();
  private disposedMaterials = new WeakSet<THREE.Material>();
  private disposedTextures = new WeakSet<THREE.Texture>();
  private isDisposed = false;
  private _disposedGeometriesCount = 0;
  private _disposedMaterialsCount = 0;

  registerGeometry<T extends THREE.BufferGeometry>(geo: T): T {
    if (geo && !this.isDisposed && !this.disposedGeometries.has(geo)) {
      this.ownedGeometries.add(geo);
    }
    return geo;
  }

  registerMaterial<T extends THREE.Material>(mat: T): T {
    if (mat && !this.isDisposed && !this.disposedMaterials.has(mat)) {
      this.ownedMaterials.add(mat);
    }
    return mat;
  }

  registerTexture<T extends THREE.Texture>(tex: T): T {
    if (tex && !this.isDisposed && !this.disposedTextures.has(tex)) {
      this.ownedTextures.add(tex);
    }
    return tex;
  }

  /**
   * Builds an indirect `MeshBVH` once for a static `THREE.Mesh` and attaches
   * `acceleratedRaycast` without mutating vertex attributes, index buffers, or `geometry.groups`.
   *
   * - `{ indirect: true }` preserves original triangle indices (`0 .. triCount - 1`) so
   *   `faceIndex -> faceRanges -> InspectableFeatureInfo` binary search works unchanged on
   *   both indexed and non-indexed geometries.
   * - For single-material meshes (`!Array.isArray(mesh.material)`), `geometry.groups` is
   *   temporarily cleared during `MeshBVH` initialization and immediately restored so that
   *   `three-mesh-bvh` builds a single unified BVH covering 100% of triangles even when
   *   merged geometries combine grouped `ShapeGeometry` items with ungrouped ribbon buffers.
   */
  enableMeshBvh<T extends THREE.Mesh>(mesh: T): T {
    if (!mesh || this.isDisposed || mesh instanceof THREE.InstancedMesh) {
      return mesh;
    }
    if (
      mesh.raycast !== THREE.Mesh.prototype.raycast &&
      mesh.raycast !== acceleratedRaycast
    ) {
      return mesh;
    }
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geo || this.disposedGeometries.has(geo)) {
      return mesh;
    }
    const pos = geo.attributes?.position;
    if (!pos || pos.count < 3) {
      return mesh;
    }
    if (geo.index && geo.index.count < 3) {
      return mesh;
    }

    this.registerGeometry(geo);

    if (!(geo as any).boundsTree) {
      const isMultiMaterial = Array.isArray(mesh.material);
      const savedGroups = geo.groups;
      if (!isMultiMaterial && savedGroups && savedGroups.length > 0) {
        geo.groups = [];
      }
      try {
        (geo as any).boundsTree = new MeshBVH(geo, { indirect: true });
      } finally {
        if (!isMultiMaterial && savedGroups && savedGroups.length > 0) {
          geo.groups = savedGroups;
        }
      }
    }

    mesh.raycast = acceleratedRaycast;
    return mesh;
  }

  /**
   * Recursively enables BVH-accelerated raycasting on all non-instanced `THREE.Mesh`
   * descendants of the given root object or group.
   */
  enableGroupBvh(root: THREE.Object3D | null | undefined): void {
    if (!root || this.isDisposed) return;
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && !(obj instanceof THREE.InstancedMesh)) {
        this.enableMeshBvh(obj);
      }
    });
  }

  private clearGeometryBvh(geo: THREE.BufferGeometry): void {
    if ((geo as any).boundsTree) {
      (geo as any).boundsTree = null;
      delete (geo as any).boundsTree;
    }
  }

  /**
   * Immediately disposes an intermediate geometry (e.g., an individual feature BufferGeometry
   * right after it has been merged into a batch BufferGeometry) and removes it from tracking.
   * Strictly single-pass and idempotent: repeated calls or calls on unowned geometries are safe no-ops.
   */
  releaseIntermediateGeometry(geo: THREE.BufferGeometry | null | undefined): void {
    if (!geo || this.isDisposed) return;
    if (this.disposedGeometries.has(geo)) return;
    if (!this.ownedGeometries.has(geo)) return;

    this.ownedGeometries.delete(geo);
    this.disposedGeometries.add(geo);
    this.clearGeometryBvh(geo);
    geo.dispose();
    this._disposedGeometriesCount++;
  }

  get ownedGeometriesCount(): number {
    return this.ownedGeometries.size;
  }

  get ownedMaterialsCount(): number {
    return this.ownedMaterials.size;
  }

  get disposedGeometriesCount(): number {
    return this._disposedGeometriesCount;
  }

  get disposedMaterialsCount(): number {
    return this._disposedMaterialsCount;
  }

  /**
   * Computes exact CPU-side JavaScript TypedArray memory (`byteLength`) across all currently
   * owned BufferGeometries (summing vertex attributes and index buffers).
   */
  getCpuBufferMemoryStats(): {
    geometryCount: number;
    attributeBytes: number;
    indexBytes: number;
    totalBytes: number;
    totalMB: number;
  } {
    let attributeBytes = 0;
    let indexBytes = 0;
    for (const geo of this.ownedGeometries) {
      if (this.disposedGeometries.has(geo)) continue;
      for (const attrName of Object.keys(geo.attributes)) {
        const attr = geo.attributes[attrName];
        if (attr && attr.array && typeof attr.array.byteLength === 'number') {
          attributeBytes += attr.array.byteLength;
        }
      }
      if (geo.index && geo.index.array && typeof geo.index.array.byteLength === 'number') {
        indexBytes += geo.index.array.byteLength;
      }
    }
    const totalBytes = attributeBytes + indexBytes;
    return {
      geometryCount: this.ownedGeometries.size,
      attributeBytes,
      indexBytes,
      totalBytes,
      totalMB: Number((totalBytes / (1024 * 1024)).toFixed(3)),
    };
  }

  /**
   * Computes exact CPU memory (`byteLength`) used by `MeshBVH` acceleration structures
   * (`_roots` node buffers and `_indirectBuffer` triangle index maps) across all currently
   * owned BufferGeometries.
   */
  getBvhMemoryStats(): {
    bvhCount: number;
    rootBytes: number;
    indirectBufferBytes: number;
    totalBytes: number;
    totalMB: number;
  } {
    let bvhCount = 0;
    let rootBytes = 0;
    let indirectBufferBytes = 0;
    for (const geo of this.ownedGeometries) {
      if (this.disposedGeometries.has(geo)) continue;
      const bvh = (geo as any).boundsTree as MeshBVH | undefined;
      if (!bvh) continue;
      bvhCount++;
      const indirectBuf = (bvh as any)._indirectBuffer as ArrayBufferView | null | undefined;
      if (indirectBuf && typeof indirectBuf.byteLength === 'number') {
        indirectBufferBytes += indirectBuf.byteLength;
      }
      const roots = (bvh as any)._roots as ArrayBuffer[] | undefined;
      if (Array.isArray(roots)) {
        for (const root of roots) {
          if (root && typeof root.byteLength === 'number') {
            rootBytes += root.byteLength;
          }
        }
      }
    }
    const totalBytes = rootBytes + indirectBufferBytes;
    return {
      bvhCount,
      rootBytes,
      indirectBufferBytes,
      totalBytes,
      totalMB: Number((totalBytes / (1024 * 1024)).toFixed(3)),
    };
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const geo of this.ownedGeometries) {
      if (!this.disposedGeometries.has(geo)) {
        this.disposedGeometries.add(geo);
        this.clearGeometryBvh(geo);
        geo.dispose();
        this._disposedGeometriesCount++;
      }
    }
    this.ownedGeometries.clear();

    for (const mat of this.ownedMaterials) {
      if (!this.disposedMaterials.has(mat)) {
        this.disposedMaterials.add(mat);
        mat.dispose();
        this._disposedMaterialsCount++;
      }
    }
    this.ownedMaterials.clear();

    for (const tex of this.ownedTextures) {
      if (!this.disposedTextures.has(tex)) {
        this.disposedTextures.add(tex);
        tex.dispose();
      }
    }
    this.ownedTextures.clear();
  }
}
