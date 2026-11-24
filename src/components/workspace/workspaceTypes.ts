import type {
  LocalSearchResultItem,
  SearchFeatureCategory,
} from '../../server/osm/OverijsselSearchIndex';

export type WorkspacePanelId =
  | 'search'
  | 'layers'
  | 'appearance'
  | 'inspector'
  | 'performance'
  | 'diagnostics'
  | 'world';

export type NavSidebarMode = 'expanded' | 'compact' | 'hidden';

export interface WorkspacePreferences {
  navMode: NavSidebarMode;
  activePanel: WorkspacePanelId | null;
  hideCameraToolbar: boolean;
}

export const WORKSPACE_PREFS_STORAGE_KEY = 'osm-renderer-workspace-prefs-v1';

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  navMode: 'expanded',
  activePanel: null,
  hideCameraToolbar: false,
};

export const WORKSPACE_PANEL_IDS: readonly WorkspacePanelId[] = [
  'search',
  'layers',
  'appearance',
  'inspector',
  'performance',
  'diagnostics',
  'world',
] as const;

export function isValidWorkspacePanelId(value: unknown): value is WorkspacePanelId {
  return (
    typeof value === 'string' &&
    (WORKSPACE_PANEL_IDS as readonly string[]).includes(value)
  );
}

export function isValidNavSidebarMode(value: unknown): value is NavSidebarMode {
  return value === 'expanded' || value === 'compact' || value === 'hidden';
}

export function togglePanelSelection(
  currentPanel: WorkspacePanelId | null,
  clickedPanel: WorkspacePanelId
): WorkspacePanelId | null {
  return currentPanel === clickedPanel ? null : clickedPanel;
}

export function cycleNavSidebarMode(currentMode: NavSidebarMode): NavSidebarMode {
  if (currentMode === 'expanded') return 'compact';
  if (currentMode === 'compact') return 'hidden';
  return 'expanded';
}

export function mapLegacyTabToPanelId(
  tab: 'layers' | 'inspector' | 'style' | 'stats' | 'info'
): WorkspacePanelId {
  switch (tab) {
    case 'layers':
      return 'layers';
    case 'inspector':
      return 'inspector';
    case 'style':
      return 'appearance';
    case 'stats':
      return 'performance';
    case 'info':
      return 'diagnostics';
  }
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadWorkspacePreferences(
  storage?: StorageLike | null
): WorkspacePreferences {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;
  if (!targetStorage) {
    return { ...DEFAULT_WORKSPACE_PREFERENCES };
  }
  try {
    const raw = targetStorage.getItem(WORKSPACE_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WORKSPACE_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<WorkspacePreferences>;
    return {
      navMode: isValidNavSidebarMode(parsed.navMode)
        ? parsed.navMode
        : DEFAULT_WORKSPACE_PREFERENCES.navMode,
      activePanel:
        parsed.activePanel === null || isValidWorkspacePanelId(parsed.activePanel)
          ? parsed.activePanel
          : DEFAULT_WORKSPACE_PREFERENCES.activePanel,
      hideCameraToolbar:
        typeof parsed.hideCameraToolbar === 'boolean'
          ? parsed.hideCameraToolbar
          : DEFAULT_WORKSPACE_PREFERENCES.hideCameraToolbar,
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_PREFERENCES };
  }
}

export function saveWorkspacePreferences(
  prefs: WorkspacePreferences,
  storage?: StorageLike | null
): void {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;
  if (!targetStorage) return;
  try {
    targetStorage.setItem(WORKSPACE_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore quota / privacy mode errors
  }
}

export interface SearchPanelSessionState {
  query: string;
  category: SearchFeatureCategory | 'all';
  results: LocalSearchResultItem[];
  lastExecutedQuery: string;
  elapsedMs: number | null;
  selectedResultId: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  recoveryHint: string | null;
  spatialIndexExists: boolean;
  isBuildingIndex: boolean;
}

export const INITIAL_SEARCH_SESSION_STATE: SearchPanelSessionState = {
  query: '',
  category: 'all',
  results: [],
  lastExecutedQuery: '',
  elapsedMs: null,
  selectedResultId: null,
  errorMessage: null,
  errorCode: null,
  recoveryHint: null,
  spatialIndexExists: true,
  isBuildingIndex: false,
};

export interface ReproFormSessionState {
  title: string;
  description: string;
  expectedBehavior: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'junction' | 'width' | 'alignment' | 'railway' | 'elevation' | 'other';
}

export const INITIAL_REPRO_FORM_STATE: ReproFormSessionState = {
  title: '',
  description: '',
  expectedBehavior: '',
  severity: 'medium',
  category: 'junction',
};

export function pickSearchTargetZoom(category: SearchFeatureCategory): number {
  switch (category) {
    case 'place':
      return 0.75;
    case 'street':
      return 1.8;
    case 'station':
      return 2.4;
    case 'building':
    case 'poi':
      return 2.8;
    case 'address':
      return 3.2;
  }
}
