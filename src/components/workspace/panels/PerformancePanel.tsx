import React from 'react';
import { Activity, Cpu, Download, HardDrive, Layers } from 'lucide-react';
import type { BuiltSceneGeometry } from '../../../world/GeometryBuilder';
import type { LiveWebGLTelemetrySnapshot } from '../../../world/prototype/PerformanceBaselineHarness';
import type { TileStreamDiagnosticsSnapshot } from '../../../world/tiling/TileStreamManager';

export interface PerformancePanelProps {
  fps: number;
  cpuBuildTimeMs: number | null;
  liveTelemetry: LiveWebGLTelemetrySnapshot | null;
  builtGeometry: BuiltSceneGeometry | null;
  isM2aStreamingActive: boolean;
  m2aStreamDiagnostics: TileStreamDiagnosticsSnapshot | null;
  onExportBenchmarkJson: () => void;
}

export const PerformancePanel: React.FC<PerformancePanelProps> = ({
  fps,
  cpuBuildTimeMs,
  liveTelemetry,
  builtGeometry,
  isM2aStreamingActive,
  m2aStreamDiagnostics,
  onExportBenchmarkJson,
}) => {
  const cpuBufferBytes =
    (isM2aStreamingActive && m2aStreamDiagnostics
      ? m2aStreamDiagnostics.tileCpuGeometryBytes + m2aStreamDiagnostics.tileBvhBytes
      : 0) + (builtGeometry?.resources.getCpuBufferMemoryStats().totalBytes ?? 0);
  const cpuBufferMb = cpuBufferBytes / (1024 * 1024);

  const streamingTileMemMb =
    m2aStreamDiagnostics !== null
      ? (m2aStreamDiagnostics.tileCpuGeometryBytes + m2aStreamDiagnostics.tileBvhBytes) /
        (1024 * 1024)
      : 0;

  return (
    <div data-testid="panel-performance" className="space-y-3.5">
      {/* 1. Frame Cadence */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            <span>Frame Cadence</span>
          </div>
          <span className="text-xs font-mono tabular-nums font-bold text-emerald-300">
            {liveTelemetry?.fps ?? fps} FPS
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px] font-mono tabular-nums">
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">Frame Interval</div>
            <div className="text-slate-100 font-semibold">
              {liveTelemetry?.frameIntervalMs !== undefined
                ? `${liveTelemetry.frameIntervalMs} ms`
                : '—'}
            </div>
          </div>
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">p50 / p95 / p99</div>
            <div className="text-cyan-300 font-semibold">
              {liveTelemetry
                ? `${liveTelemetry.medianFrameIntervalMs} / ${liveTelemetry.p95FrameIntervalMs} / ${liveTelemetry.p99FrameIntervalMs} ms`
                : '—'}
            </div>
          </div>
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">Spikes (&gt;33 / &gt;50ms)</div>
            <div className="text-amber-300 font-semibold">
              {liveTelemetry
                ? `${liveTelemetry.spikesOver33msCount} / ${liveTelemetry.spikesOver50msCount}`
                : '0 / 0'}
            </div>
          </div>
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">Max Spike · Raycast</div>
            <div className="text-slate-200">
              {liveTelemetry
                ? `${liveTelemetry.maxSpikeDurationMs}ms · ${liveTelemetry.hoverRaycastTimeMs ?? 0}ms`
                : '—'}
            </div>
          </div>
        </div>
      </section>

      {/* 2. GPU & WebGL Render Pass */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <Cpu className="w-3.5 h-3.5 text-cyan-400" />
            <span>WebGL Render Pass</span>
          </div>
          <span className="text-[10px] font-mono text-slate-400 truncate max-w-[150px]" title={liveTelemetry?.gpuRenderer}>
            {liveTelemetry?.gpuRenderer?.includes('SwiftShader')
              ? 'SwiftShader GL'
              : liveTelemetry?.gpuRenderer || 'WebGL2'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px] font-mono tabular-nums">
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">Draw Calls</div>
            <div className="text-amber-300 font-semibold">
              {(liveTelemetry?.renderCalls ?? builtGeometry?.stats.totalDrawCalls ?? 0).toLocaleString()}
            </div>
          </div>
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">Rendered Triangles</div>
            <div className="text-cyan-300 font-semibold">
              {(
                liveTelemetry?.renderTriangles ??
                m2aStreamDiagnostics?.loadedTriangles ??
                builtGeometry?.stats.totalTriangles ??
                0
              ).toLocaleString()}
            </div>
          </div>
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">GPU Timer Query</div>
            <div className="text-slate-200">
              {liveTelemetry?.gpuPassTimeMs != null
                ? `${liveTelemetry.gpuPassTimeMs} ms`
                : liveTelemetry?.gpuTimerQuerySupported
                  ? 'Pending'
                  : 'Unsupported'}
            </div>
          </div>
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">CPU Render / Init</div>
            <div className="text-slate-200">
              {liveTelemetry?.cpuRenderTimeMs != null
                ? `${liveTelemetry.cpuRenderTimeMs}ms`
                : '—'}
              {' · '}
              {typeof cpuBuildTimeMs === 'number' ? `${cpuBuildTimeMs}ms` : '—'}
            </div>
          </div>
        </div>

        <div className="bg-slate-950/80 border border-slate-800 rounded p-2 text-[10px] font-mono tabular-nums text-slate-400 flex items-center justify-between gap-2">
          <span>
            Driver Geos: <strong className="text-slate-200">{liveTelemetry?.driverGeometries ?? 0}</strong>
          </span>
          <span>
            Tex: <strong className="text-slate-200">{liveTelemetry?.driverTextures ?? 0}</strong>
          </span>
          <span>
            Progs: <strong className="text-slate-200">{liveTelemetry?.driverPrograms ?? 0}</strong>
          </span>
        </div>

        <div className="bg-slate-950/80 border border-slate-800 rounded p-2 text-[10px] font-mono tabular-nums text-slate-400 flex items-center justify-between gap-2">
          <span>
            Rail Meshes Vis:{' '}
            <strong className="text-slate-200">
              {liveTelemetry?.activeFrustumCulledRailwayMeshes ?? 0}/
              {liveTelemetry?.activeRailwayMeshes ?? 0}
            </strong>
          </span>
          <span>
            Vis Rail Tris:{' '}
            <strong className="text-cyan-300">
              {(liveTelemetry?.activeFrustumVisibleRailwayTriangles ?? 0).toLocaleString()}
            </strong>
          </span>
        </div>
      </section>

      {/* 3. CPU & Tile Memory */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <HardDrive className="w-3.5 h-3.5 text-purple-400" />
            <span>Buffer &amp; BVH Memory</span>
          </div>
          <span className="text-xs font-mono tabular-nums font-bold text-purple-300">
            {cpuBufferMb.toFixed(2)} MB
          </span>
        </div>

        {(() => {
          const mem =
            typeof performance !== 'undefined' ? (performance as any).memory : null;
          if (!mem || typeof mem.usedJSHeapSize !== 'number') return null;
          return (
            <div className="text-[11px] font-mono tabular-nums text-slate-400 flex items-center justify-between bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5">
              <span>JS Heap Used</span>
              <span className="text-slate-200">
                {(mem.usedJSHeapSize / (1024 * 1024)).toFixed(1)} MB
              </span>
            </div>
          );
        })()}
      </section>

      {/* 4. Regional Tile Streaming Metrics */}
      {isM2aStreamingActive && m2aStreamDiagnostics && (
        <section
          data-testid="performance-tile-streaming"
          className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span>OSMTILE1 Tile Streaming</span>
            </div>
            <span className="text-[10px] font-mono tabular-nums text-emerald-300">
              {m2aStreamDiagnostics.loadedTiles}/{m2aStreamDiagnostics.totalGridTiles} loaded
            </span>
          </div>

          <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono tabular-nums">
            <div className="bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-[10px] text-slate-500">Visible / Loading</div>
              <div className="text-cyan-300">
                {m2aStreamDiagnostics.visibleTiles} vis · {m2aStreamDiagnostics.loadingTiles} load
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-[10px] text-slate-500">Evicted / Cancelled</div>
              <div className="text-slate-200">
                {m2aStreamDiagnostics.evictedTilesTotal} ev · {m2aStreamDiagnostics.cancelledRequestsTotal} can
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-[10px] text-slate-500">Tile Mem (Geom+BVH)</div>
              <div className="text-purple-300">{streamingTileMemMb.toFixed(2)} MB</div>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-[10px] text-slate-500">Shared Mats · Meshes</div>
              <div className="text-slate-200">
                {m2aStreamDiagnostics.sharedMaterialCount} mat · {m2aStreamDiagnostics.loadedMeshCount}
              </div>
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded p-2 text-[10px] font-mono tabular-nums text-slate-400 space-y-1">
            <div className="flex items-center justify-between">
              <span>Avg Fetch / Decode</span>
              <span className="text-slate-200">
                {m2aStreamDiagnostics.avgFetchMs.toFixed(1)}ms ·{' '}
                {m2aStreamDiagnostics.avgDecodeMs.toFixed(1)}ms
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Avg Reconstruct / Max Commit</span>
              <span className="text-cyan-300">
                {m2aStreamDiagnostics.avgReconstructMs.toFixed(1)}ms ·{' '}
                {m2aStreamDiagnostics.maxCommitMs.toFixed(1)}ms
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Export Action */}
      <button
        type="button"
        data-testid="btn-export-benchmark-json"
        onClick={onExportBenchmarkJson}
        className="w-full py-2 px-3 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 text-xs font-semibold flex items-center justify-center gap-2 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer"
      >
        <Download className="w-3.5 h-3.5" />
        <span>Export Benchmark JSON</span>
      </button>
    </div>
  );
};
