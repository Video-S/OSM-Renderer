import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkEnvironmentMetadata, GitMetadataStatus } from './types';

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

export interface ResolvedGitState {
  gitCommitSha: string;
  gitDirty: boolean;
  gitBranch: string | null;
  gitMetadataStatus: GitMetadataStatus;
  gitMetadataReason?: string;
}

function runGitCommand(args: readonly string[], cwd: string) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveCiEnvCommitSha(env: NodeJS.ProcessEnv): {
  sha: string | null;
  branch: string | null;
} {
  const candidates = [env.GITHUB_SHA, env.CI_COMMIT_SHA, env.COMMIT_SHA];
  for (const raw of candidates) {
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (/^[a-f0-9]{7,40}$/i.test(trimmed)) {
        return {
          sha: trimmed.slice(0, 12),
          branch: env.GITHUB_REF_NAME || env.CI_COMMIT_REF_NAME || null,
        };
      }
    }
  }
  return { sha: null, branch: null };
}

/**
 * Resolves the current git commit SHA, branch, and working-tree dirty state.
 * Distinguishes valid repositories, unborn HEADs, dubious ownership, missing git CLI,
 * CI-only SHA metadata, and non-git directories without fabricating commit hashes.
 */
export function resolveGitState(
  cwd: string = process.cwd(),
  options: {
    env?: NodeJS.ProcessEnv;
    disableRepoRootFallback?: boolean;
  } = {}
): ResolvedGitState {
  const env = options.env ?? process.env;
  const moduleRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const candidateDirs = options.disableRepoRootFallback
    ? [path.resolve(cwd)]
    : Array.from(new Set([path.resolve(cwd), moduleRepoRoot]));

  let sawDubiousOwnershipError = false;
  let lastErrorMessage: string | undefined;

  for (const dir of candidateDirs) {
    const inside = runGitCommand(['rev-parse', '--is-inside-work-tree'], dir);
    if (inside.error) {
      const code = (inside.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const ci = resolveCiEnvCommitSha(env);
        if (ci.sha) {
          return {
            gitCommitSha: ci.sha,
            gitDirty: false,
            gitBranch: ci.branch,
            gitMetadataStatus: 'ci_env_only',
            gitMetadataReason:
              'git executable not found in PATH; commit SHA read from CI environment variable (working-tree dirty state unavailable).',
          };
        }
        return {
          gitCommitSha: 'unknown',
          gitDirty: false,
          gitBranch: null,
          gitMetadataStatus: 'git_unavailable',
          gitMetadataReason: 'git executable was not found in PATH.',
        };
      }
      lastErrorMessage = inside.error.message;
      continue;
    }

    const insideStderr = (inside.stderr || '').trim();
    if (inside.status !== 0) {
      if (/dubious ownership/i.test(insideStderr)) {
        sawDubiousOwnershipError = true;
        lastErrorMessage = insideStderr;
      } else if (insideStderr && !/not a git repository/i.test(insideStderr)) {
        lastErrorMessage = insideStderr;
      }
      continue;
    }

    if ((inside.stdout || '').trim() !== 'true') {
      continue;
    }

    const statusRes = runGitCommand(['status', '--porcelain'], dir);
    const gitDirty = statusRes.status === 0 ? statusRes.stdout.trim().length > 0 : false;

    const branchRes = runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    const rawBranch = branchRes.status === 0 ? branchRes.stdout.trim() : '';
    const gitBranch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;

    const headRes = runGitCommand(['rev-parse', '--short=12', 'HEAD'], dir);
    const sha = headRes.status === 0 ? headRes.stdout.trim() : '';
    if (sha) {
      return {
        gitCommitSha: sha,
        gitDirty,
        gitBranch,
        gitMetadataStatus: 'available',
      };
    }

    const headStderr = (headRes.stderr || '').trim();
    if (/unknown revision|needed a single revision|ambiguous argument 'HEAD'/i.test(headStderr)) {
      return {
        gitCommitSha: 'unborn-head',
        gitDirty,
        gitBranch: null,
        gitMetadataStatus: 'unborn_head',
        gitMetadataReason:
          'Git repository is initialized in this workspace, but HEAD has no commits yet.',
      };
    }

    return {
      gitCommitSha: 'unknown',
      gitDirty,
      gitBranch,
      gitMetadataStatus: 'error',
      gitMetadataReason: headStderr || 'git rev-parse HEAD failed with an unknown error.',
    };
  }

  if (sawDubiousOwnershipError) {
    return {
      gitCommitSha: 'unknown',
      gitDirty: false,
      gitBranch: null,
      gitMetadataStatus: 'dubious_ownership',
      gitMetadataReason:
        lastErrorMessage ||
        'Git rejected repository access due to dubious ownership (configure git safe.directory if needed).',
    };
  }

  const ci = resolveCiEnvCommitSha(env);
  if (ci.sha) {
    return {
      gitCommitSha: ci.sha,
      gitDirty: false,
      gitBranch: ci.branch,
      gitMetadataStatus: 'ci_env_only',
      gitMetadataReason:
        'No .git directory found; commit SHA read from CI environment variable (working-tree dirty state unavailable).',
    };
  }

  if (lastErrorMessage) {
    return {
      gitCommitSha: 'unknown',
      gitDirty: false,
      gitBranch: null,
      gitMetadataStatus: 'error',
      gitMetadataReason: lastErrorMessage,
    };
  }

  return {
    gitCommitSha: 'unknown',
    gitDirty: false,
    gitBranch: null,
    gitMetadataStatus: 'not_a_git_repository',
    gitMetadataReason:
      'No .git repository metadata was found in the workspace (e.g., archive/snapshot export); commit SHA is unavailable.',
  };
}

/**
 * Collects host hardware, OS, and Node.js runtime environment metadata.
 */
export function collectHostEnvironmentMetadata(
  browserMeta?: BenchmarkEnvironmentMetadata['browser']
): BenchmarkEnvironmentMetadata {
  const { gitCommitSha, gitDirty, gitBranch, gitMetadataStatus, gitMetadataReason } =
    resolveGitState();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Unknown CPU';
  const cpuLogicalCores = cpus.length;
  const totalSystemMemoryMB = Math.round(os.totalmem() / (1024 * 1024));

  return {
    gitCommitSha,
    gitDirty,
    gitBranch,
    gitMetadataStatus,
    ...(gitMetadataReason ? { gitMetadataReason } : {}),
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
    'Wall-clock interval (ms) between consecutive completed WebGL gl.render() calls measured post-render across the scenario. Distinct from synchronous CPU render duration and asynchronous GPU pass time.',
  effectiveMedianFps:
    'Steady-state frame cadence derived strictly from median frameIntervalMs (1000 / medianFrameIntervalMs).',
  cpuFrameRenderTimeMs:
    'Synchronous CPU main-thread execution duration (ms) of Three.js WebGLRenderer.render(scene, camera) per frame.',
  gpuFrameRenderTimeMs:
    'Asynchronous GPU command execution duration (ms) measured via WebGL2 EXT_disjoint_timer_query_webgl2 when supported and non-disjoint; explicitly null with valid/pending/disjoint/unsupported status counts when unavailable or running on software rasterizers.',
  webglDrawCallsPerFrame:
    'Actual WebGL draw calls issued per frame recorded from Three.js gl.info.render.calls immediately after gl.render().',
  renderedTrianglesPerFrame:
    'Actual triangles submitted to WebGL per frame recorded from Three.js gl.info.render.triangles immediately after gl.render().',
  railwayVisibility:
    'Static scene railway counts (staticRailwayMeshes, staticRailwayTriangles) computed once at scene commit, plus deterministic stride-sampled frustum visibility metrics (activeRailwayMeshes, frustumCulledRailwayMeshes, frustumVisibleRailwayTriangles) over a zero-traversal cached index. Null when unavailable.',
  instrumentationOverheadMs:
    'Measured CPU bookkeeping duration (ms) of the post-render benchmark telemetry collector itself per frame.',
});

export const MEMORY_MEASUREMENT_NOTES: readonly string[] = Object.freeze([
  'cpuBufferMemoryMB measures exact TypedArray byteLengths allocated on owned Three.js BufferGeometries and InstancedMesh instance matrices; it is 100% deterministic across runs.',
  'v8HeapMemory (process.memoryUsage) and browser performance.memory reflect V8 garbage collector timing, JIT compilation caches, and allocator fragmentation. Even when Node.js is launched with --expose-gc, V8 heap deltas are approximate indicators rather than strict byte-accurate allocations.',
  'lifecycleAudit (ownedGeometriesAfterDispose, ownedMaterialsAfterDispose, and WebGL gl.info.memory.geometries) provides the authoritative deterministic check for Three.js / WebGL resource leaks.',
]);
