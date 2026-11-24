import React from 'react';
import {
  Gauge,
  Globe,
  Layers,
  MousePointerClick,
  Palette,
  Search,
  Wrench,
  X,
} from 'lucide-react';
import type { WorkspacePanelId } from './workspaceTypes';

export interface ContextSidebarProps {
  activePanel: WorkspacePanelId | null;
  onClose: () => void;
  children: React.ReactNode;
}

const PANEL_META: Record<
  WorkspacePanelId,
  {
    title: string;
    subtitle: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  search: {
    title: 'Local Search',
    subtitle: 'Offline Overijssel SQLite index',
    icon: Search,
  },
  layers: {
    title: 'Map Layers',
    subtitle: 'Visibility & feature categories',
    icon: Layers,
  },
  appearance: {
    title: 'Appearance',
    subtitle: 'Visual theme & geometry scale',
    icon: Palette,
  },
  inspector: {
    title: 'Inspector',
    subtitle: 'Spatial selection & OSM tags',
    icon: MousePointerClick,
  },
  performance: {
    title: 'Performance',
    subtitle: 'Frame cadence & streaming telemetry',
    icon: Gauge,
  },
  diagnostics: {
    title: 'Diagnostics',
    subtitle: 'Overlays, load timing & repro',
    icon: Wrench,
  },
  world: {
    title: 'World & Mosaic',
    subtitle: 'Active baked dataset & zoom policy',
    icon: Globe,
  },
};

export const ContextSidebar: React.FC<ContextSidebarProps> = ({
  activePanel,
  onClose,
  children,
}) => {
  if (!activePanel) return null;
  const meta = PANEL_META[activePanel];
  const Icon = meta.icon;

  return (
    <aside
      data-testid="workspace-context-sidebar"
      data-active-panel={activePanel}
      aria-label={`${meta.title} panel`}
      className="w-[340px] shrink-0 h-full bg-slate-950 border-l border-slate-800 flex flex-col select-text"
    >
      <header className="h-12 px-3.5 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0 bg-slate-900/50">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-md bg-slate-900 border border-slate-800 flex items-center justify-center text-cyan-400 shrink-0">
            <Icon className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-slate-100 leading-tight truncate">
              {meta.title}
            </h2>
            <p className="text-[11px] text-slate-400 leading-tight truncate">
              {meta.subtitle}
            </p>
          </div>
        </div>

        <button
          type="button"
          data-testid="btn-close-context-panel"
          onClick={onClose}
          aria-label={`Close ${meta.title} panel`}
          title="Close panel"
          className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5">{children}</div>
    </aside>
  );
};
