import * as THREE from 'three';

/**
 * Explicit GPU Resource Manager ensuring single-pass, idempotent cleanup,
 * immediate disposal of intermediate geometries after buffer merging,
 * and protection against duplicate disposal of shared materials.
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

  get disposed(): boolean {
    return this.isDisposed;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const geo of this.ownedGeometries) {
      if (!this.disposedGeometries.has(geo)) {
        this.disposedGeometries.add(geo);
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
