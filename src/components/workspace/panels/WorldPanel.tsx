import React from 'react';
import { AlertTriangle, Database, Globe, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CameraZoomPolicy } from '../../../scene/cameraZoomPolicy';
import type { ProcessedMapData } from '../../../types/MapFeature';
import type { ActiveMosaicIdentity } from '../../../world/tiling/ActiveMosaicIdentity';
import type {
  TileManifestCoverageSummary,
  TileStreamDiagnosticsSnapshot,
} from '../../../world/tiling/TileStreamManager';

export interface WorldPanelProps {
  activeMosaicIdentity: ActiveMosaicIdentity;
  manifestCoverage: TileManifestCoverageSummary | null;
  m2aStreamDiagnostics: TileStreamDiagnosticsSnapshot | null;
  cameraZoomPolicy: CameraZoomPolicy;
  mapData: ProcessedMapData | null;
  activeLocationId: string;
  isM2aStreamingActive: boolean;
  onReloadRegionalMosaic: () => void;
}

function zoomPolicySourceLabel(source: CameraZoomPolicy['source']): string {
  switch (source) {
    case 'regional_default':
      return 'Regional Safeguard';
    case 'url_override':
      return 'URL Override';
    case 'programmatic_override':
      return 'Programmatic Override';
    case 'fallback_invalid_override':
      return 'Default Fallback';
    case 'standard_default':
      return 'Standard';
  }
}

export const WorldPanel: React.FC<WorldPanelProps> = ({
  activeMosaicIdentity,
  manifestCoverage,
  m2aStreamDiagnostics,
  cameraZoomPolicy,
  mapData,
  activeLocationId,
  isM2aStreamingActive,
  onReloadRegionalMosaic,
}) => {
  const status = activeMosaicIdentity.status;
  const extentWidthKm = manifestCoverage
    ? ((manifestCoverage.gridCols * manifestCoverage.tileSizeMeters) / 1000).toFixed(2)
    : null;
  const extentDepthKm = manifestCoverage
    ? ((manifestCoverage.gridRows * manifestCoverage.tileSizeMeters) / 1000).toFixed(2)
    : null;

  return (
    <div data-testid="panel-world" className="space-y-3.5">
      {/* Active Mosaic / Dataset Identity */}
      <section
        data-testid="active-mosaic-diagnostics"
        className={`rounded-md p-3 space-y-2.5 border ${
          status === 'error'
            ? 'bg-rose-950/30 border-rose-500/40'
            : status === 'loading'
              ? 'bg-amber-950/20 border-amber-500/40'
              : status === 'loaded'
                ? 'bg-slate-900/70 border-emerald-500/35'
                : 'bg-slate-900/60 border-slate-800'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <Database className="w-3.5 h-3.5 text-cyan-400" />
            <span>
              {activeMosaicIdentity.isRegionalStreaming
                ? 'Active Regional Mosaic'
                : isM2aStreamingActive
                  ? 'Active Tile Pack'
                  : 'Active Scene Source'}
            </span>
          </div>
          <span
            data-testid="active-mosaic-status"
            className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
              status === 'loaded'
                ? 'bg-emerald-500/20 text-emerald-300'
                : status === 'loading'
                  ? 'bg-amber-500/20 text-amber-300'
                  : status === 'error'
                    ? 'bg-rose-500/20 text-rose-300'
                    : 'bg-slate-800 text-slate-300'
            }`}
          >
            {status === 'loaded'
              ? 'Loaded'
              : status === 'loading'
                ? 'Loading'
                : status === 'error'
                  ? 'Unavailable'
                  : activeLocationId}
          </span>
        </div>

        {status === 'loading' && (
          <div className="bg-slate-950 border border-slate-800 rounded p-2.5 text-[11px] font-mono text-amber-200">
            Active Mosaic: Loading manifest...
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-2">
            <div className="bg-slate-950 border border-rose-500/35 rounded p-2.5 text-[11px] font-mono text-rose-200 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-rose-300">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Mosaic Unavailable</span>
              </div>
              {activeMosaicIdentity.errorMessage && (
                <div className="text-[10px] text-rose-300/90 break-words">
                  {activeMosaicIdentity.errorMessage}
                </div>
              )}
            </div>
            <button
              type="button"
              data-testid="btn-world-reload-mosaic"
              onClick={onReloadRegionalMosaic}
              className="w-full py-1.5 px-2.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
              <span>Retry Regional Mosaic</span>
            </button>
          </div>
        )}

        {status === 'inactive' && (
          <div className="space-y-2">
            <div className="bg-slate-950 border border-slate-800 rounded p-2.5 text-[11px] text-slate-300 space-y-1">
              <div className="font-semibold text-slate-100 truncate">
                {mapData?.regionName || 'No dataset loaded'}
              </div>
              <div className="text-[10px] font-mono text-slate-400">
                Mode: Non-regional fixture / live GeoJSON ({activeLocationId})
              </div>
            </div>
            <button
              type="button"
              data-testid="btn-world-load-regional-mosaic"
              onClick={onReloadRegionalMosaic}
              className="w-full py-1.5 px-2.5 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>Load Regional Mosaic</span>
            </button>
          </div>
        )}

        {status === 'loaded' && (
          <div className="space-y-2">
            <div className="bg-slate-950 border border-slate-800 rounded p-2.5 space-y-1.5 text-[11px] font-mono tabular-nums">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400 shrink-0">Active Mosaic</span>
                <span
                  data-testid="active-mosaic-name"
                  title={activeMosaicIdentity.packPath ?? undefined}
                  className="text-emerald-300 font-bold text-right break-all"
                >
                  {activeMosaicIdentity.mosaicName ?? 'Unknown'}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400 shrink-0">Source Snapshot</span>
                <span
                  data-testid="active-mosaic-source"
                  className="text-slate-200 text-right break-all"
                >
                  {activeMosaicIdentity.snapshotId ?? 'Unknown'}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-400 shrink-0">Tiles · Schema</span>
                <span
                  data-testid="active-mosaic-tiles-schema"
                  className="text-cyan-300 text-right"
                >
                  {activeMosaicIdentity.tileCount ?? '—'} ·{' '}
                  {activeMosaicIdentity.bakeSchemaVersion ?? '—'}
                  {activeMosaicIdentity.tileSizeMeters !== null
                    ? ` (${activeMosaicIdentity.tileSizeMeters}m)`
                    : ''}
                </span>
              </div>
              {manifestCoverage && (
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-slate-400 shrink-0">Projection · Codec</span>
                  <span className="text-slate-300 text-right">
                    {manifestCoverage.projection} · {manifestCoverage.compression}
                  </span>
                </div>
              )}
            </div>

            {activeMosaicIdentity.packPath && (
              <details className="bg-slate-950/70 border border-slate-800 rounded px-2.5 py-1.5 text-[10px] font-mono text-slate-400">
                <summary className="cursor-pointer text-slate-300 hover:text-cyan-300 select-none">
                  Full Manifest Path
                </summary>
                <div
                  data-testid="active-mosaic-full-path"
                  className="mt-1.5 text-slate-300 break-all select-all"
                >
                  {activeMosaicIdentity.packPath}
                </div>
              </details>
            )}
          </div>
        )}
      </section>

      {/* Grid Footprint & Geographic Coverage */}
      {status === 'loaded' && manifestCoverage && (
        <section
          data-testid="world-grid-footprint"
          className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200">
              Footprint &amp; Coverage
            </span>
            <span className="text-[10px] font-mono tabular-nums text-cyan-300">
              {manifestCoverage.projection}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono tabular-nums">
            <div className="bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-[10px] text-slate-500">Grid · Shards (4×4)</div>
              <div className="text-slate-100">
                {manifestCoverage.gridCols}×{manifestCoverage.gridRows} ·{' '}
                {manifestCoverage.shardCountEstimate ?? '—'} sh
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-[10px] text-slate-500">Regional Extent</div>
              <div className="text-slate-100">
                {extentWidthKm} × {extentDepthKm} km
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-[10px] text-slate-500">Populated Tiles</div>
              <div className="text-emerald-300 font-semibold">
                {manifestCoverage.nonEmptyTiles.toLocaleString()}
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-[10px] text-slate-500">Empty Border Tiles</div>
              <div className="text-slate-400">
                {manifestCoverage.emptyTiles.toLocaleString()}
              </div>
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded p-2 text-[10px] font-mono tabular-nums text-slate-400 space-y-1">
            <div>
              Origin (UTM 32N):{' '}
              <span className="text-slate-200">
                E {Math.round(manifestCoverage.studyOriginEasting)} · N{' '}
                {Math.round(manifestCoverage.studyOriginNorthing)}
              </span>
            </div>
            {manifestCoverage.boundsGeo && (
              <div>
                Geo Bounds:{' '}
                <span className="text-slate-200">
                  {manifestCoverage.boundsGeo.minLat.toFixed(4)}°–
                  {manifestCoverage.boundsGeo.maxLat.toFixed(4)}°N,{' '}
                  {manifestCoverage.boundsGeo.minLon.toFixed(4)}°–
                  {manifestCoverage.boundsGeo.maxLon.toFixed(4)}°E
                </span>
              </div>
            )}
            {manifestCoverage.boundsUtm && (
              <div>
                UTM Bounds:{' '}
                <span className="text-slate-300">
                  E [{Math.round(manifestCoverage.boundsUtm.minEasting)},{' '}
                  {Math.round(manifestCoverage.boundsUtm.maxEasting)}] · N [
                  {Math.round(manifestCoverage.boundsUtm.minNorthing)},{' '}
                  {Math.round(manifestCoverage.boundsUtm.maxNorthing)}]
                </span>
              </div>
            )}
            {m2aStreamDiagnostics && (
              <div>
                Streaming Margins:{' '}
                <span className="text-cyan-300">
                  preload {m2aStreamDiagnostics.preloadMarginTiles} · retain{' '}
                  {m2aStreamDiagnostics.retainMarginTiles} tiles
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Camera Zoom Policy */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
            <span>Camera Zoom Policy</span>
          </div>
          <span className="text-[10px] font-mono text-slate-400">
            {zoomPolicySourceLabel(cameraZoomPolicy.source)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono tabular-nums">
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">Min Zoom (Out)</div>
            <div data-testid="effective-min-zoom" className="text-cyan-300 font-semibold">
              {cameraZoomPolicy.minZoom}x
            </div>
          </div>
          <div className="bg-slate-950 border border-slate-800 rounded p-2">
            <div className="text-[10px] text-slate-500">Max Zoom (In)</div>
            <div className="text-slate-200 font-semibold">{cameraZoomPolicy.maxZoom}x</div>
          </div>
        </div>

        {cameraZoomPolicy.invalidOverrideRejected && (
          <div className="text-[10px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
            Ignored invalid regionalMinZoom=&quot;{cameraZoomPolicy.requestedOverrideRaw}&quot;; using{' '}
            {cameraZoomPolicy.minZoom}x.
          </div>
        )}
      </section>

      {/* OSM Attribution */}
      <div className="text-[10px] font-mono text-slate-500 px-1 flex items-center justify-between">
        <span>Data © OpenStreetMap contributors</span>
        <span>ODbL 1.0</span>
      </div>
    </div>
  );
};
