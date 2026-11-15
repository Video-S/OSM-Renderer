import {
  BenchmarkRendererConfig,
  BrowserScenarioKind,
  BrowserScenarioSpec,
} from './types';

export const BENCHMARK_RENDERER_CONFIGS: readonly BenchmarkRendererConfig[] = Object.freeze([
  {
    id: 'production-legacy',
    label: 'Production Default (Legacy Roads + Candidate B Railways)',
    themeId: 'tactical',
    railwayPrototypeMode: 'production',
    infrastructureRenderOptions: {
      roads: 'legacy',
      railways: 'legacy',
    },
    buildingHeightMultiplier: 1.0,
    roadWidthMultiplier: 1.0,
    bevelEnabled: false,
  },
  {
    id: 'graph-e2-e3',
    label: 'Graph-Driven Topology (E2 Graph Roads + E3-A2 Graph Switches)',
    themeId: 'tactical',
    railwayPrototypeMode: 'production',
    infrastructureRenderOptions: {
      roads: 'graph',
      railways: 'graph-switches',
      railwaySwitchPolicy: 'graph',
      railwayBallastStrategy: 'ribbon',
    },
    buildingHeightMultiplier: 1.0,
    roadWidthMultiplier: 1.0,
    bevelEnabled: false,
  },
  {
    id: 'surface-first-e2plus-rplus',
    label: 'Surface-First Topology (E2+ Road Footprints + E3-B R+ Ballast)',
    themeId: 'tactical',
    railwayPrototypeMode: 'production',
    infrastructureRenderOptions: {
      roads: 'graph-surface',
      railways: 'graph-R+',
      railwaySwitchPolicy: 'graph',
      railwayBallastStrategy: 'surface-first',
    },
    buildingHeightMultiplier: 1.0,
    roadWidthMultiplier: 1.0,
    bevelEnabled: false,
  },
]);

export const BROWSER_BENCHMARK_SCENARIOS: readonly BrowserScenarioSpec[] = Object.freeze([
  {
    id: 'static_overview',
    name: 'Static Overview Camera (Zoom 1.0x)',
    description:
      'Fixed isometric camera centered at [0, 0, 0] at zoom=1.0x (medium/far procedural railway LOD, full region in frustum).',
    warmupFrames: 12,
    measuredFrames: 36,
  },
  {
    id: 'static_close_junction',
    name: 'Static Close-Zoom Junction & Throat (Zoom 8.0x)',
    description:
      'Fixed close-zoom camera at zoom=8.0x (> 4.5 CSS px/m threshold, activating 3D instanced railway sleepers and 3D extruded steel rails).',
    warmupFrames: 12,
    measuredFrames: 36,
  },
  {
    id: 'automated_pan_sweep',
    name: 'Automated Camera Pan Sweep across Region (Zoom 5.5x)',
    description:
      'Deterministic linear camera translation across the loaded region bounding box at close zoom=5.5x, exercising spatial chunk frustum culling.',
    warmupFrames: 8,
    measuredFrames: 36,
  },
  {
    id: 'zoom_and_orbit_sweep',
    name: 'Automated Camera Zoom & Azimuth Orbit Sweep (1.2x -> 8.5x)',
    description:
      'Simultaneous camera zoom sweep crossing the 4.5x railway 2D/3D LOD transition threshold and 270-degree azimuth rotation.',
    warmupFrames: 8,
    measuredFrames: 36,
  },
  {
    id: 'repeated_scene_reload',
    name: 'Repeated Scene Load, Build, First-Render & Unload Lifecycle',
    description:
      'Repeatedly unloads, rebuilds, and renders the dataset in WebGL, verifying initialization latency and zero leaked WebGL driver geometries or textures.',
    warmupFrames: 6,
    measuredFrames: 24,
    reloadCycles: 4,
  },
]);

export function resolveRendererConfigs(
  filterIds?: readonly string[]
): BenchmarkRendererConfig[] {
  if (!filterIds || filterIds.length === 0) {
    return [...BENCHMARK_RENDERER_CONFIGS];
  }
  const wanted = new Set(filterIds.map((id) => id.trim()));
  const matched = BENCHMARK_RENDERER_CONFIGS.filter((c) => wanted.has(c.id));
  if (matched.length === 0) {
    const available = BENCHMARK_RENDERER_CONFIGS.map((c) => c.id).join(', ');
    throw new Error(
      `No renderer configurations matched filter [${filterIds.join(', ')}]. Available config IDs: ${available}`
    );
  }
  return matched;
}

export function resolveBrowserScenarios(
  filterIds?: readonly BrowserScenarioKind[]
): BrowserScenarioSpec[] {
  if (!filterIds || filterIds.length === 0) {
    return [...BROWSER_BENCHMARK_SCENARIOS];
  }
  const wanted = new Set(filterIds);
  const matched = BROWSER_BENCHMARK_SCENARIOS.filter((s) => wanted.has(s.id));
  if (matched.length === 0) {
    const available = BROWSER_BENCHMARK_SCENARIOS.map((s) => s.id).join(', ');
    throw new Error(
      `No browser scenarios matched filter [${filterIds.join(', ')}]. Available scenario IDs: ${available}`
    );
  }
  return matched;
}
