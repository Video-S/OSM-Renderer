import * as THREE from 'three';

/**
 * TKT-031: conservative main color pass *submission proxy* for one mesh.
 *
 * The Three.js renderer submits a mesh separately for each usable material
 * group if material is an array; with a single material, mesh is one draw.
 * This counts plausible submissions only. It does NOT observe WebGL calls,
 * shadow frustums/passes, GPU work, transparencies, culling or occlusion.
 */
export function estimateMainPassSubmissions(mesh: THREE.Mesh): number {
  const material = mesh.material;
  if (!mesh.geometry || !material) return 0;
  if ((mesh as THREE.InstancedMesh).isInstancedMesh &&
      (mesh as THREE.InstancedMesh).count <= 0) return 0;
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  if (!positions || positions.count === 0) return 0;
  const drawCount = geometry.index ? geometry.index.count : positions.count;
  const start = Math.max(0, geometry.drawRange.start);
  const end = Math.min(drawCount, start + geometry.drawRange.count);
  if (end <= start) return 0;

  if (!Array.isArray(material)) {
    return material.visible ? 1 : 0;
  }

  let count = 0;
  for (const group of geometry.groups) {
    const mat = material[group.materialIndex];
    if (!mat?.visible) continue;
    const groupStart = Math.max(start, group.start);
    const groupEnd = Math.min(end, group.start + group.count);
    if (groupEnd > groupStart) count++;
  }
  return count;
}

export interface SceneLayerDrawWorkEstimate {
  /** Candidate draws in the color pass, AFTER main-camera frustum check. */
  mainPassSubmissions: number;
  /** Shadow candidates in the main-camera frustum; NOT actual shadow calls. */
  mainFrustumShadowCasterSubmissions: number;
  /** Eligible instanced objects inside main camera frustum. */
  instancedMeshes: number;
  /** Main camera frustum-qualified meshes with a usable material. */
  drawableMeshes: number;
}

export function emptyLayerDrawWork(): SceneLayerDrawWorkEstimate {
  return {
    mainPassSubmissions: 0,
    mainFrustumShadowCasterSubmissions: 0,
    instancedMeshes: 0,
    drawableMeshes: 0,
  };
}

export function addLayerDrawWork(
  dst: SceneLayerDrawWorkEstimate,
  mesh: THREE.Mesh
): void {
  const count = estimateMainPassSubmissions(mesh);
  if (count <= 0) return;
  dst.drawableMeshes++;
  dst.mainPassSubmissions += count;
  if (mesh.castShadow) {
    dst.mainFrustumShadowCasterSubmissions += count;
  }
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
    dst.instancedMeshes++;
  }
}
