import { execSync } from 'node:child_process';
import os from 'node:os';
import { BenchmarkEnvironmentMetadata } from './types';

/**
 * Determines whether a WebGL UNMASKED_RENDERER_WEBGL string corresponds to a
 * software rasterizer (such as Google SwiftShader, Mesa llvmpipe/softpipe, Lavapipe,
 * or Microsoft Basic Render Driver) versus a hardware GPU driver.
 */
export function isSoftwareWebGLRenderer(rendererString: string | null | undefined): boolean {
  if (!rendererString) return true;
  const lower = rendererString.toLowerCase();
  return (
    lower.includes('swiftshader') ||
    lower.includes('llvmpipe') ||
    lower.includes('softpipe') ||
    lower.includes('lavapipe') ||
    lower.includes('software') ||
    lower.includes('basic render driver') ||
    lower.includes('subzero')
  );
}

/**
 * Resolves the current git commit SHA and working-tree dirty state.
 * Falls back gracefully to 'unknown' if executed outside a git repository.
 */
export function resolveGitState(cwd: string = process.cwd()): {
  gitCommitSha: string;
  gitDirty: boolean;
} {
  try {
    const sha = execSync('git rev-parse --short=12 HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    const status = execSync('git status --porcelain', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return {
      gitCommitSha: sha || 'unknown',
      gitDirty: status.length > 0,
    };
  } catch {
    return {
      gitCommitSha: 'unknown',
      gitDirty: false,
    };
  }
}

/**
 * Collects host hardware, OS, and Node.js runtime environment metadata.
 */
export function collectHostEnvironmentMetadata(
  browserMeta?: BenchmarkEnvironmentMetadata['browser']
): BenchmarkEnvironmentMetadata {
  const { gitCommitSha, gitDirty } = resolveGitState();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Unknown CPU';
  const cpuLogicalCores = cpus.length;
  const totalSystemMemoryMB = Math.round(os.totalmem() / (1024 * 1024));

  return {
    gitCommitSha,
    gitDirty,
    timestampIso: new Date().toISOString(),
    nodeVersion: process.version,
    v8Version: process.versions.v8 || 'unknown',
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpuModel,
    cpuLogicalCores,
    totalSystemMemoryMB,
    gcExposed: typeof (globalThis as any).gc === 'function',
    ...(browserMeta ? { browser: browserMeta } : {}),
  };
}

export const STANDARD_METRIC_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  geojsonParseAndClassifyMs:
    'Wall-clock CPU time (ms) in LocalGeoJsonProvider.parseGeoJson to classify OSM tags, project WGS84 coordinates to local meters, clip to region bounds, and extract pre-chaining topologySource.',
  infrastructureGraphBuildMs:
    'Wall-clock CPU time (ms) in buildInfrastructureGraph to construct RoadNetwork, RailwayNetwork, and CrossModalAnalyzer connectivity relations.',
  graphToRendererAdapterMs:
    'Wall-clock CPU time (ms) in adaptInfrastructureGraphToRenderDescriptors and validateInfrastructureRenderDescriptors.',
  planarSurfaceResolutionMs:
    'Wall-clock CPU time (ms) in resolveAndValidatePlanarPolygons performing 2D Boolean ownership resolution and elevation separation for landuse, parks, and water.',
  roadGeometryGenerationMs:
    'Wall-clock CPU time (ms) in buildGraphAtGradeRoadGeometries constructing at-grade road and junction BufferGeometries.',
  railwayGeometryGenerationMs:
    'Wall-clock CPU time (ms) in buildRailwayInfrastructure constructing ballast, 3D instanced sleepers/bearers, 3D rails, and procedural UV ribbons.',
  fullSceneGeometryGenerationMs:
    'Wall-clock CPU time (ms) in GeometryBuilder.buildScene generating all 3D scene groups, materials, and spatial chunks.',
  sceneResourceDisposalMs:
    'Wall-clock CPU time (ms) in BuiltSceneGeometry.dispose() releasing all owned Three.js BufferGeometries, Materials, and Textures.',
  cpuBufferMemoryMB:
    'Exact deterministic sum (MB) of JavaScript TypedArray byteLengths across all active BufferGeometry vertex attributes, index buffers, and InstancedMesh matrices.',
  frameIntervalMs:
    'Browser requestAnimationFrame-to-requestAnimationFrame wall-clock interval (ms). Distinct from CPU render call duration and GPU execution time.',
  effectiveMedianFps:
    'Steady-state frame cadence derived from median frameIntervalMs (1000 / medianFrameIntervalMs).',
  cpuFrameRenderTimeMs:
    'Synchronous CPU main-thread execution duration (ms) of Three.js WebGLRenderer.render(scene, camera) per frame.',
  gpuFrameRenderTimeMs:
    'Asynchronous GPU command execution duration (ms) measured via WebGL2 EXT_disjoint_timer_query_webgl2 when supported and non-disjoint; explicitly null when unsupported or running on software rasterizers.',
  webglDrawCallsPerFrame:
    'Actual WebGL draw calls issued per frame recorded from Three.js gl.info.render.calls immediately after gl.render().',
  renderedTrianglesPerFrame:
    'Actual triangles submitted to WebGL per frame recorded from Three.js gl.info.render.triangles immediately after gl.render().',
});

export const MEMORY_MEASUREMENT_NOTES: readonly string[] = Object.freeze([
  'cpuBufferMemoryMB measures exact TypedArray byteLengths allocated on owned Three.js BufferGeometries and InstancedMesh instance matrices; it is 100% deterministic across runs.',
  'v8HeapMemory (process.memoryUsage) and browser performance.memory reflect V8 garbage collector timing, JIT compilation caches, and allocator fragmentation. Even when Node.js is launched with --expose-gc, V8 heap deltas are approximate indicators rather than strict byte-accurate allocations.',
  'lifecycleAudit (ownedGeometriesAfterDispose, ownedMaterialsAfterDispose, and WebGL gl.info.memory.geometries) provides the authoritative deterministic check for Three.js / WebGL resource leaks.',
]);
