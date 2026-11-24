import fs from 'node:fs';
import type { Request, Response } from 'express';
import {
  resolveOverijsselIndexPath,
  resolveOverijsselSearchIndexPath,
} from './overijsselConfig';
import {
  OverijsselIndexIncompatibleError,
  OverijsselIndexMissingError,
} from './OverijsselOsmStore';
import {
  buildOverijsselSearchIndex,
  OverijsselSearchIndexIncompatibleError,
  OverijsselSearchIndexMissingError,
  OverijsselSearchStore,
  type ActiveMosaicCoverageContext,
  type OverijsselSearchMetadata,
  type SearchFeatureCategory,
} from './OverijsselSearchIndex';

const VALID_CATEGORIES = new Set<SearchFeatureCategory>([
  'place',
  'street',
  'station',
  'building',
  'poi',
  'address',
]);

export interface SearchHttpHandlerOptions {
  spatialIndexPath?: string;
  searchIndexPath?: string;
  expectedSha256?: string;
  expectedSnapshotId?: string;
  allowCustomSnapshot?: boolean;
  getMosaicCoverage?: () => ActiveMosaicCoverageContext | null;
}

export interface SearchDataController {
  searchHandler: (req: Request, res: Response) => Promise<void>;
  statusHandler: (req: Request, res: Response) => Promise<void>;
  buildHandler: (req: Request, res: Response) => Promise<void>;
  ensureReady: () => Promise<OverijsselSearchMetadata | null>;
  getStatus: () => {
    available: boolean;
    building: boolean;
    spatialIndexExists: boolean;
    spatialIndexPath: string;
    searchIndexPath: string;
    metadata: OverijsselSearchMetadata | null;
    error: string | null;
    code: string | null;
  };
  close: () => void;
}

export function createSearchDataHandler(
  options: SearchHttpHandlerOptions = {}
): SearchDataController {
  const spatialIndexPath = options.spatialIndexPath ?? resolveOverijsselIndexPath();
  const searchIndexPath =
    options.searchIndexPath ?? resolveOverijsselSearchIndexPath(spatialIndexPath);

  let store: OverijsselSearchStore | null = null;
  let buildPromise: Promise<OverijsselSearchMetadata | null> | null = null;

  const getStore = (): OverijsselSearchStore => {
    if (!store) {
      store = new OverijsselSearchStore(searchIndexPath, spatialIndexPath, {
        expectedSha256: options.expectedSha256,
        expectedSnapshotId: options.expectedSnapshotId,
        allowCustomSnapshot: options.allowCustomSnapshot,
      });
    }
    return store;
  };

  const resetStore = (): void => {
    if (store) {
      store.close();
      store = null;
    }
  };

  const getStatus = () => {
    const spatialIndexExists = fs.existsSync(spatialIndexPath);
    if (buildPromise) {
      return {
        available: false,
        building: true,
        spatialIndexExists,
        spatialIndexPath,
        searchIndexPath,
        metadata: null,
        error: 'Building offline local search index from Overijssel SQLite store...',
        code: 'SEARCH_INDEX_BUILDING',
      };
    }
    try {
      const s = getStore();
      return {
        available: true,
        building: false,
        spatialIndexExists,
        spatialIndexPath,
        searchIndexPath,
        metadata: s.getMetadata(),
        error: null,
        code: null,
      };
    } catch (err: any) {
      resetStore();
      const code =
        err instanceof OverijsselSearchIndexIncompatibleError
          ? 'SEARCH_INDEX_INCOMPATIBLE'
          : err instanceof OverijsselSearchIndexMissingError
            ? 'SEARCH_INDEX_MISSING'
            : err instanceof OverijsselIndexIncompatibleError
              ? 'OVERIJSSEL_INDEX_INCOMPATIBLE'
              : err instanceof OverijsselIndexMissingError
                ? 'OVERIJSSEL_INDEX_MISSING'
                : 'SEARCH_INDEX_UNAVAILABLE';
      return {
        available: false,
        building: false,
        spatialIndexExists,
        spatialIndexPath,
        searchIndexPath,
        metadata: null,
        error: err?.message ?? String(err),
        code,
      };
    }
  };

  const ensureReady = async (): Promise<OverijsselSearchMetadata | null> => {
    try {
      return getStore().getMetadata();
    } catch (err) {
      resetStore();
      if (!fs.existsSync(spatialIndexPath)) {
        return null;
      }
      if (
        !(
          err instanceof OverijsselSearchIndexMissingError ||
          err instanceof OverijsselSearchIndexIncompatibleError
        )
      ) {
        return null;
      }
    }

    if (!buildPromise) {
      buildPromise = (async () => {
        try {
          buildOverijsselSearchIndex({
            spatialIndexPath,
            outSearchIndexPath: searchIndexPath,
            expectedSha256: options.expectedSha256,
            expectedSnapshotId: options.expectedSnapshotId,
            allowCustomSnapshot: options.allowCustomSnapshot,
          });
          resetStore();
          return getStore().getMetadata();
        } catch (err) {
          resetStore();
          throw err;
        } finally {
          buildPromise = null;
        }
      })();
    }

    return buildPromise;
  };

  const statusHandler = async (_req: Request, res: Response): Promise<void> => {
    const status = getStatus();
    res.setHeader('Cache-Control', 'no-cache');
    res.status(status.available ? 200 : 503).json(status);
  };

  const buildHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!fs.existsSync(spatialIndexPath)) {
        res.status(503).json({
          available: false,
          code: 'OVERIJSSEL_INDEX_MISSING',
          error:
            `Overijssel spatial index not found at "${spatialIndexPath}". ` +
            `Run "npm run osm:setup-overijssel" first.`,
          spatialIndexPath,
          searchIndexPath,
        });
        return;
      }
      if (!buildPromise) {
        buildPromise = (async () => {
          try {
            buildOverijsselSearchIndex({
              spatialIndexPath,
              outSearchIndexPath: searchIndexPath,
              expectedSha256: options.expectedSha256,
              expectedSnapshotId: options.expectedSnapshotId,
              allowCustomSnapshot: options.allowCustomSnapshot,
            });
            resetStore();
            return getStore().getMetadata();
          } finally {
            buildPromise = null;
          }
        })();
      }
      const metadata = await buildPromise;
      res.status(200).json({
        available: true,
        building: false,
        metadata,
        spatialIndexPath,
        searchIndexPath,
      });
    } catch (err: any) {
      resetStore();
      res.status(503).json({
        available: false,
        building: false,
        code: 'SEARCH_INDEX_BUILD_FAILED',
        error: err?.message ?? String(err),
        spatialIndexPath,
        searchIndexPath,
      });
    }
  };

  const searchHandler = async (req: Request, res: Response): Promise<void> => {
    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rawCategory =
      typeof req.query.category === 'string' ? req.query.category.trim() : 'all';
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;

    if (!rawQuery) {
      res.status(400).json({
        error: 'Query parameter "q" is required',
        code: 'SEARCH_EMPTY_QUERY',
      });
      return;
    }

    const category: SearchFeatureCategory | 'all' =
      rawCategory === 'all' || VALID_CATEGORIES.has(rawCategory as SearchFeatureCategory)
        ? (rawCategory as SearchFeatureCategory | 'all')
        : 'all';

    try {
      const s = getStore();
      const mosaicContext = options.getMosaicCoverage?.() ?? null;
      const result = s.search({
        query: rawQuery,
        category,
        limit: Number.isFinite(rawLimit) ? rawLimit : 20,
        mosaicContext,
      });
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-OSM-Search-Source', 'overijssel-local-fts5');
      res.setHeader('X-OSM-Snapshot-Id', result.snapshotId);
      res.status(200).json(result);
    } catch (err: any) {
      resetStore();
      const status = getStatus();
      res.status(503).json({
        available: false,
        building: status.building,
        code: status.code ?? 'SEARCH_INDEX_UNAVAILABLE',
        error: err?.message ?? 'Local search index unavailable',
        recoveryHint: status.spatialIndexExists
          ? 'Run "npm run osm:build-search-index" to generate the local FTS5 search index.'
          : 'Run "npm run osm:setup-overijssel && npm run osm:build-search-index" to prepare the offline Overijssel dataset and search index.',
      });
    }
  };

  return {
    searchHandler,
    statusHandler,
    buildHandler,
    ensureReady,
    getStatus,
    close: resetStore,
  };
}
