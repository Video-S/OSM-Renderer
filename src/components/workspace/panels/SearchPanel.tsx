import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Database,
  Loader2,
  MapPin,
  Navigation,
  Search,
  Train,
  X,
} from 'lucide-react';
import type {
  LocalSearchResultItem,
  OverijsselSearchQueryResponse,
  SearchFeatureCategory,
} from '../../../server/osm/OverijsselSearchIndex';
import type { TileManifestCoverageSummary } from '../../../world/tiling/TileStreamManager';
import { RegionalProjection } from '../../../world/tiling/RegionalProjection';
import {
  pickSearchTargetZoom,
  type SearchPanelSessionState,
} from '../workspaceTypes';

export interface SearchPanelProps {
  session: SearchPanelSessionState;
  onUpdateSession: React.Dispatch<React.SetStateAction<SearchPanelSessionState>>;
  activeMosaicName: string | null;
  manifestCoverage: TileManifestCoverageSummary | null;
  currentZoom: number;
  onNavigateToResult: (params: {
    result: LocalSearchResultItem;
    worldX: number;
    worldZ: number;
    targetZoom: number;
  }) => void;
}

const CATEGORY_OPTIONS: ReadonlyArray<{
  id: SearchFeatureCategory | 'all';
  label: string;
}> = [
  { id: 'all', label: 'All' },
  { id: 'place', label: 'Places' },
  { id: 'street', label: 'Streets' },
  { id: 'station', label: 'Stations' },
  { id: 'building', label: 'Buildings' },
  { id: 'poi', label: 'POIs' },
  { id: 'address', label: 'Addresses' },
];

function categoryIcon(cat: SearchFeatureCategory) {
  switch (cat) {
    case 'station':
      return Train;
    case 'street':
      return Navigation;
    case 'building':
      return Building2;
    default:
      return MapPin;
  }
}

function categoryBadgeLabel(cat: SearchFeatureCategory): string {
  switch (cat) {
    case 'place':
      return 'Place';
    case 'street':
      return 'Street';
    case 'station':
      return 'Station';
    case 'building':
      return 'Building';
    case 'poi':
      return 'POI';
    case 'address':
      return 'Address';
  }
}

export const SearchPanel: React.FC<SearchPanelProps> = ({
  session,
  onUpdateSession,
  activeMosaicName,
  manifestCoverage,
  currentZoom,
  onNavigateToResult,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const executeSearch = async (
    queryText: string,
    category: SearchFeatureCategory | 'all'
  ) => {
    const trimmed = queryText.trim();
    if (!trimmed) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      onUpdateSession((prev) => ({
        ...prev,
        results: [],
        lastExecutedQuery: '',
        elapsedMs: null,
        errorMessage: null,
        errorCode: null,
        recoveryHint: null,
      }));
      setIsLoading(false);
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsLoading(true);

    try {
      const url = `/api/search?q=${encodeURIComponent(trimmed)}&category=${encodeURIComponent(
        category
      )}&limit=25`;
      const res = await fetch(url, { signal: controller.signal });
      if (controller.signal.aborted) return;

      if (!res.ok) {
        let errPayload: any = null;
        try {
          errPayload = await res.json();
        } catch {
          errPayload = null;
        }
        onUpdateSession((prev) => ({
          ...prev,
          results: [],
          lastExecutedQuery: trimmed,
          elapsedMs: null,
          errorMessage: errPayload?.error ?? `Search failed (HTTP ${res.status})`,
          errorCode: errPayload?.code ?? 'SEARCH_INDEX_UNAVAILABLE',
          recoveryHint: errPayload?.recoveryHint ?? null,
          isBuildingIndex: Boolean(errPayload?.building),
        }));
        setIsLoading(false);
        return;
      }

      const data = (await res.json()) as OverijsselSearchQueryResponse;
      if (controller.signal.aborted) return;

      onUpdateSession((prev) => ({
        ...prev,
        results: data.results ?? [],
        lastExecutedQuery: trimmed,
        elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : null,
        errorMessage: null,
        errorCode: null,
        recoveryHint: null,
        isBuildingIndex: false,
      }));
      setIsLoading(false);
    } catch (err: any) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        return;
      }
      onUpdateSession((prev) => ({
        ...prev,
        results: [],
        lastExecutedQuery: trimmed,
        elapsedMs: null,
        errorMessage: err?.message ?? 'Local search request failed',
        errorCode: 'SEARCH_REQUEST_ERROR',
        recoveryHint: null,
      }));
      setIsLoading(false);
    }
  };

  // Probe index status when mounted if there's an existing error or empty state
  const refreshStatus = async () => {
    try {
      const res = await fetch('/api/search/status');
      const data = await res.json();
      onUpdateSession((prev) => ({
        ...prev,
        spatialIndexExists: Boolean(data?.spatialIndexExists),
        isBuildingIndex: Boolean(data?.building),
        errorCode: data?.available ? null : data?.code ?? prev.errorCode,
        errorMessage: data?.available ? null : data?.error ?? prev.errorMessage,
      }));
    } catch {
      // ignore passive probe errors
    }
  };

  const handleBuildSearchIndex = async () => {
    onUpdateSession((prev) => ({
      ...prev,
      isBuildingIndex: true,
      errorMessage: 'Building local FTS5 search index from Overijssel spatial store...',
      errorCode: 'SEARCH_INDEX_BUILDING',
    }));
    try {
      const res = await fetch('/api/search/build', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data?.available) {
        onUpdateSession((prev) => ({
          ...prev,
          isBuildingIndex: false,
          errorMessage: data?.error ?? 'Failed to build search index',
          errorCode: data?.code ?? 'SEARCH_INDEX_BUILD_FAILED',
        }));
        return;
      }
      onUpdateSession((prev) => ({
        ...prev,
        isBuildingIndex: false,
        errorMessage: null,
        errorCode: null,
        recoveryHint: null,
      }));
      if (session.query.trim()) {
        void executeSearch(session.query, session.category);
      }
    } catch (err: any) {
      onUpdateSession((prev) => ({
        ...prev,
        isBuildingIndex: false,
        errorMessage: err?.message ?? 'Failed to build search index',
        errorCode: 'SEARCH_INDEX_BUILD_FAILED',
      }));
    }
  };

  // Debounced auto-search when query or category changes
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    const trimmed = session.query.trim();
    if (!trimmed) {
      if (session.results.length > 0 || session.lastExecutedQuery) {
        onUpdateSession((prev) => ({
          ...prev,
          results: [],
          lastExecutedQuery: '',
          elapsedMs: null,
        }));
      }
      return;
    }
    debounceTimerRef.current = setTimeout(() => {
      void executeSearch(trimmed, session.category);
    }, 220);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [session.query, session.category]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Client-side coordinate & boundary verification fallback if server coverage was unknown
  const resolveResultDestination = (item: LocalSearchResultItem) => {
    const cov = item.coverage;
    if (cov.status === 'covered' && cov.worldX !== null && cov.worldZ !== null) {
      return {
        navigable: true,
        status: cov.status,
        worldX: cov.worldX,
        worldZ: cov.worldZ,
        reason: cov.reason,
        tileKey: cov.tileKey,
      };
    }
    if (cov.status === 'empty_tile' || cov.status === 'outside_mosaic') {
      return {
        navigable: false,
        status: cov.status,
        worldX: cov.worldX,
        worldZ: cov.worldZ,
        reason: cov.reason,
        tileKey: cov.tileKey,
      };
    }
    if (manifestCoverage && manifestCoverage.boundsUtm) {
      const b = manifestCoverage.boundsUtm;
      const inUtm =
        item.utmEasting >= b.minEasting &&
        item.utmEasting <= b.maxEasting &&
        item.utmNorthing >= b.minNorthing &&
        item.utmNorthing <= b.maxNorthing;
      const proj = new RegionalProjection(
        manifestCoverage.studyOriginEasting,
        manifestCoverage.studyOriginNorthing
      );
      const [wx, wz] = proj.utmToLocal(item.utmEasting, item.utmNorthing);
      return {
        navigable: inUtm,
        status: inUtm ? ('covered' as const) : ('outside_mosaic' as const),
        worldX: wx,
        worldZ: wz,
        reason: inUtm ? null : 'Outside active baked mosaic bounds',
        tileKey: null,
      };
    }
    return {
      navigable: false,
      status: 'unknown' as const,
      worldX: null,
      worldZ: null,
      reason: 'Regional mosaic not loaded',
      tileKey: null,
    };
  };

  return (
    <div data-testid="panel-search" className="space-y-3">
      {/* Search Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          void executeSearch(session.query, session.category);
        }}
        className="space-y-2"
      >
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            data-testid="search-panel-input"
            value={session.query}
            onChange={(e) =>
              onUpdateSession((prev) => ({ ...prev, query: e.target.value }))
            }
            placeholder="Places, streets, stations, addresses..."
            aria-label="Search offline Overijssel OSM features"
            className="w-full bg-slate-900 border border-slate-800 rounded-md pl-8 pr-8 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
          />
          {session.query && (
            <button
              type="button"
              data-testid="btn-search-clear"
              onClick={() =>
                onUpdateSession((prev) => ({
                  ...prev,
                  query: '',
                  results: [],
                  lastExecutedQuery: '',
                  elapsedMs: null,
                }))
              }
              aria-label="Clear search query"
              className="p-1 text-slate-400 hover:text-slate-100 absolute right-1.5 top-1/2 -translate-y-1/2 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Category Filter */}
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Search category filter"
        >
          {CATEGORY_OPTIONS.map((opt) => {
            const active = session.category === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                data-testid={`search-category-${opt.id}`}
                aria-pressed={active}
                onClick={() =>
                  onUpdateSession((prev) => ({ ...prev, category: opt.id }))
                }
                className={`px-2 py-1 rounded text-[11px] font-medium border transition cursor-pointer ${
                  active
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </form>

      {/* Active Mosaic Coverage Context */}
      <div className="bg-slate-900/70 border border-slate-800 rounded-md px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2">
        <span className="text-slate-400 flex items-center gap-1.5 truncate">
          <Database className="w-3 h-3 text-cyan-400 shrink-0" />
          <span className="truncate">
            {activeMosaicName ? `Target: ${activeMosaicName}` : 'No regional mosaic loaded'}
          </span>
        </span>
        {session.elapsedMs !== null && (
          <span className="text-[10px] font-mono tabular-nums text-slate-400 shrink-0">
            {session.results.length} in {session.elapsedMs.toFixed(1)}ms
          </span>
        )}
      </div>

      {/* Loading Indicator */}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-2 px-1">
          <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin shrink-0" />
          <span>Querying local FTS5 index...</span>
        </div>
      )}

      {/* Index Unavailable / Building / Recovery State */}
      {session.errorMessage && (
        <div
          data-testid="search-error-banner"
          className="bg-rose-950/30 border border-rose-500/35 rounded-md p-3 space-y-2 text-xs"
        >
          <div className="flex items-start gap-2 text-rose-200">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <div className="font-semibold">
                {session.isBuildingIndex
                  ? 'Building Local Search Index'
                  : 'Local Search Unavailable'}
              </div>
              <p className="text-[11px] text-rose-200/85 break-words">
                {session.errorMessage}
              </p>
              {session.recoveryHint && (
                <p className="text-[10px] font-mono text-slate-300 bg-slate-950/80 border border-slate-800 rounded px-2 py-1 break-words">
                  {session.recoveryHint}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {(session.errorCode === 'SEARCH_INDEX_MISSING' ||
              session.errorCode === 'SEARCH_INDEX_INCOMPATIBLE') && (
              <button
                type="button"
                data-testid="btn-build-search-index"
                disabled={session.isBuildingIndex}
                onClick={handleBuildSearchIndex}
                className="px-2.5 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-[11px] font-semibold disabled:opacity-50 cursor-pointer"
              >
                {session.isBuildingIndex ? 'Building...' : 'Build Search Index Now'}
              </button>
            )}
            <button
              type="button"
              onClick={refreshStatus}
              className="px-2.5 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-medium cursor-pointer"
            >
              Check Status
            </button>
          </div>
        </div>
      )}

      {/* Initial Empty Prompt */}
      {!session.query.trim() && !session.errorMessage && (
        <div className="bg-slate-900/50 border border-slate-800 rounded-md p-3 text-[11px] text-slate-400 space-y-1.5">
          <div className="font-medium text-slate-200">
            Offline Overijssel Search
          </div>
          <p>
            Search cities, towns, villages, streets, railway stations, named buildings, POIs, and addresses directly from the local SQLite FTS5 index.
          </p>
          <p className="text-slate-500">
            No external geocoding requests are made. Results verify coverage against the active baked mosaic before navigating.
          </p>
        </div>
      )}

      {/* No Matches */}
      {session.query.trim() &&
        !isLoading &&
        !session.errorMessage &&
        session.lastExecutedQuery &&
        session.results.length === 0 && (
          <div
            data-testid="search-empty-results"
            className="bg-slate-900/50 border border-slate-800 rounded-md p-3 text-center text-xs text-slate-400"
          >
            No Overijssel features matched &ldquo;{session.lastExecutedQuery}&rdquo;.
          </div>
        )}

      {/* Search Results */}
      {session.results.length > 0 && (
        <ul data-testid="search-results-list" className="space-y-1.5">
          {session.results.map((item) => {
            const Icon = categoryIcon(item.category);
            const dest = resolveResultDestination(item);
            const isSelected = session.selectedResultId === item.id;
            const targetZoom = Math.max(currentZoom, pickSearchTargetZoom(item.category));

            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid={`search-result-${item.id}`}
                  disabled={!dest.navigable}
                  onClick={() => {
                    if (!dest.navigable || dest.worldX === null || dest.worldZ === null) {
                      return;
                    }
                    onUpdateSession((prev) => ({
                      ...prev,
                      selectedResultId: item.id,
                    }));
                    onNavigateToResult({
                      result: item,
                      worldX: dest.worldX,
                      worldZ: dest.worldZ,
                      targetZoom,
                    });
                  }}
                  title={
                    dest.navigable
                      ? `Navigate camera to ${item.name} (${item.lat.toFixed(5)}°, ${item.lon.toFixed(5)}°)`
                      : dest.reason ?? 'Outside active mosaic coverage'
                  }
                  className={`w-full text-left p-2.5 rounded-md border transition ${
                    dest.navigable
                      ? isSelected
                        ? 'bg-cyan-500/15 border-cyan-500/45 text-slate-100 cursor-pointer'
                        : 'bg-slate-900/80 border-slate-800 hover:border-slate-700 hover:bg-slate-900 text-slate-200 cursor-pointer'
                      : 'bg-slate-950/70 border-slate-800/70 text-slate-500 opacity-75 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <Icon
                        className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                          dest.navigable ? 'text-cyan-400' : 'text-slate-600'
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">
                          {item.name}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate">
                          {[item.locality, item.postcode, item.subtype]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </div>
                    </div>

                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-300 shrink-0">
                      {categoryBadgeLabel(item.category)}
                    </span>
                  </div>

                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums">
                    <span className="text-slate-500">
                      {item.lat.toFixed(4)}°, {item.lon.toFixed(4)}°
                    </span>
                    <span
                      className={
                        dest.status === 'covered'
                          ? 'text-emerald-400'
                          : dest.status === 'empty_tile'
                            ? 'text-amber-400'
                            : dest.status === 'outside_mosaic'
                              ? 'text-rose-400'
                              : 'text-slate-500'
                      }
                    >
                      {dest.status === 'covered'
                        ? dest.tileKey
                          ? `Tile ${dest.tileKey}`
                          : 'In Mosaic'
                        : dest.status === 'empty_tile'
                          ? 'Empty Tile'
                          : dest.status === 'outside_mosaic'
                            ? 'Outside Mosaic'
                            : 'No Mosaic'}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
