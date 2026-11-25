import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ConnectionFilters, NodeFilters, RelPath } from '../shared';
import { SidebarSection, Segmented, SwitchRow } from './controls';
import type { SegmentOption } from './controls';
import type { FocusDirection } from './focus';
import { FOCUS_DEPTHS, FOCUS_DIRECTIONS } from './focus';
import type { ExportTabProps } from './ExportTab';
import type { UnusedCodePanel } from './FiltersTab';
import { ExportTab } from './ExportTab';
import type { FolderColorEntry, WorkspaceColorEntry } from './folderColors';
import { FiltersTab } from './FiltersTab';
import type { IconName } from './icons';
import { Icon } from './icons';
import type { FolderEntry } from './nodeFilters';
import { countActiveNodeFilters } from './nodeFilters';
import type { ReviewTabProps } from './ReviewTab';
import { ReviewTab } from './ReviewTab';
import type { SearchTabProps } from './SearchTab';
import { SearchTab } from './SearchTab';

/** Tabs of the sidebar. */
export type SidebarTab =
  'search' | 'connections' | 'filters' | 'focus' | 'view' | 'review' | 'export';

/** Most folders listed in the color legend. */
const MAX_LISTED_FOLDER_COLORS = 12;

/** Search state and callbacks (see {@link SearchTab}). */
export type SidebarSearch = Omit<SearchTabProps, 'inputRef'>;

/** Node filter state and the data needed to edit it. */
export interface SidebarFilters {
  readonly filters: NodeFilters;
  readonly onChange: (filters: NodeFilters) => void;
  /** Every folder of the workspace (also the hidden ones). */
  readonly folders: readonly FolderEntry[];
  /** Color of each folder that directly contains files. */
  readonly folderColors: ReadonlyMap<RelPath, string>;
  /** Workspace folders with their colors (multi-root); empty with one folder. */
  readonly workspaceFolders: readonly WorkspaceColorEntry[];
  /** Unused code detection. */
  readonly unused: UnusedCodePanel;
  readonly hiddenFiles: number;
  readonly hiddenFunctions: number;
}

/** Focus mode state and callbacks. */
export interface SidebarFocus {
  /** Name of the focused node, or `null` outside focus mode. */
  readonly label: string | null;
  /** File of the focused node, or `null`. */
  readonly detail: string | null;
  readonly depth: number;
  readonly direction: FocusDirection;
  /** Focuses the selected file or function. */
  readonly onFocusSelected: () => void;
  readonly onExit: () => void;
  readonly onDepthChange: (depth: number) => void;
  readonly onDirectionChange: (direction: FocusDirection) => void;
}

/** View actions and toggles. */
export interface SidebarView {
  readonly onExpandLevel: () => void;
  readonly onExpandAll: () => void;
  readonly onCollapseAll: () => void;
  readonly onRelayout: () => void;
  readonly minimapShown: boolean;
  readonly onToggleMinimap: () => void;
  readonly folderColorsEnabled: boolean;
  readonly onToggleFolderColors: () => void;
  /** Folders and their colors, largest first (legend). */
  readonly folderColors: readonly FolderColorEntry[];
  /** Workspace folders and their colors (multi-root legend); empty with one folder. */
  readonly workspaceColors: readonly WorkspaceColorEntry[];
  readonly editorSync: boolean;
  readonly onEditorSyncChange: (enabled: boolean) => void;
}

/** Props of {@link Sidebar}. */
interface SidebarProps {
  readonly search: SidebarSearch;
  readonly connections: ConnectionFilters;
  readonly onConnectionsChange: (connections: ConnectionFilters) => void;
  readonly filters: SidebarFilters;
  readonly focus: SidebarFocus;
  readonly view: SidebarView;
  readonly exportTab: ExportTabProps;
  readonly reviewTab: ReviewTabProps;
  /** Pending request to show the Changes tab ("Review Changes" command), by sequence. */
  readonly reviewOpenRequest: number | null;
  /** Called once the Changes tab was shown for a request. */
  readonly onReviewOpenHandled: (sequence: number) => void;
}

/** Rail entries, in display order. */
const TABS: readonly {
  readonly id: SidebarTab;
  readonly icon: IconName;
  readonly title: string;
}[] = [
  { id: 'search', icon: 'search', title: 'Search' },
  { id: 'connections', icon: 'connections', title: 'Connections' },
  { id: 'filters', icon: 'filter', title: 'Filters' },
  { id: 'focus', icon: 'focus', title: 'Focus' },
  { id: 'view', icon: 'view', title: 'View' },
  { id: 'review', icon: 'gitCompare', title: 'Changes' },
  { id: 'export', icon: 'download', title: 'Export' },
];

/** Options of the focus depth selector. */
const DEPTH_OPTIONS: readonly SegmentOption<number>[] = FOCUS_DEPTHS.map((depth) => ({
  value: depth,
  label: depth === 1 ? '1 hop' : `${String(depth)} hops`,
}));

/** Labels and tooltips of the focus directions. */
const DIRECTION_OPTIONS: readonly SegmentOption<FocusDirection>[] = FOCUS_DIRECTIONS.map(
  (direction) =>
    ({
      both: { value: direction, label: 'Both', title: 'What it uses and what uses it' },
      incoming: { value: direction, label: 'Used by', title: 'Who imports or calls it' },
      outgoing: { value: direction, label: 'Uses', title: 'What it imports or calls' },
    })[direction],
);

/**
 * Sample of a connection line, shown next to its switch.
 *
 * @param props - Modifier of the line style.
 * @returns The SVG sample.
 */
function LineSample({
  variant,
}: {
  readonly variant: 'import' | 'call' | 'internal';
}): JSX.Element {
  return (
    <svg className="cg-line-sample" viewBox="0 0 28 8" aria-hidden="true">
      <line className={`cg-line-sample__${variant}`} x1="1" y1="4" x2="27" y2="4" />
    </svg>
  );
}

/** Props of {@link RailButton}. */
interface RailButtonProps {
  readonly icon: IconName;
  readonly title: string;
  readonly active: boolean;
  readonly onClick: () => void;
  /** Small counter or dot drawn on the icon. */
  readonly badge?: ReactNode;
}

/**
 * Icon button of the rail.
 *
 * @param props - Icon, label, state, badge and callback.
 * @returns The button element.
 */
function RailButton({ icon, title, active, onClick, badge }: RailButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="cg-rail__button"
      aria-label={title}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      <Icon name={icon} size={18} />
      {badge !== undefined && badge !== null && <span className="cg-rail__badge">{badge}</span>}
    </button>
  );
}

/**
 * Badge of the Changes tab: the number of changed functions and files while
 * a review runs.
 *
 * @param review - Changes tab state.
 * @returns The badge, or `null` without review.
 */
function reviewBadge(review: ReviewTabProps): ReactNode {
  if (review.state === null) {
    return null;
  }
  return review.impact === null || review.impact.changed === 0 ? (
    <span className="cg-rail__dot" />
  ) : (
    Math.min(review.impact.changed, 99)
  );
}

/**
 * Settings and filters sidebar: a vertical rail of icons (Search,
 * Connections, Filters, Focus, View) that opens a panel next to it. Clicking
 * the active icon, the close button or pressing Escape inside closes the
 * panel; Ctrl/Cmd+F opens the search.
 *
 * @param props - State and callbacks of every tab.
 * @returns The sidebar element.
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const [tab, setTab] = useState<SidebarTab | null>(null);
  const { search, connections, onConnectionsChange, filters, focus, view, exportTab, reviewTab } =
    props;
  const { reviewOpenRequest, onReviewOpenHandled } = props;

  // The "Review Changes" command opens the Changes tab.
  useEffect(() => {
    if (reviewOpenRequest === null) {
      return;
    }
    onReviewOpenHandled(reviewOpenRequest);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab('review');
  }, [reviewOpenRequest, onReviewOpenHandled]);

  // Ctrl/Cmd+F opens the search tab from anywhere in the webview.
  useEffect(() => {
    /**
     * Opens the search tab on Ctrl/Cmd+F.
     *
     * @param event - Keyboard event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setTab('search');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Focus the search box when the search tab opens.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (tab === 'search') {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [tab]);

  const activeFilters = countActiveNodeFilters(filters.filters);
  const badges: Readonly<Record<SidebarTab, ReactNode>> = {
    search: search.query.trim() === '' ? null : <span className="cg-rail__dot" />,
    connections: null,
    filters: activeFilters === 0 ? null : activeFilters,
    focus: focus.label === null ? null : <span className="cg-rail__dot" />,
    view: view.editorSync ? <span className="cg-rail__dot" /> : null,
    review: reviewBadge(reviewTab),
    export: null,
  };
  const current = TABS.find((entry) => entry.id === tab);

  return (
    <div className="cg-sidebar nowheel" aria-label="Settings and filters">
      <nav className="cg-rail" aria-label="Sidebar">
        {TABS.map((entry) => (
          <RailButton
            key={entry.id}
            icon={entry.icon}
            title={entry.title}
            active={tab === entry.id}
            badge={badges[entry.id]}
            onClick={() => {
              setTab((open) => (open === entry.id ? null : entry.id));
            }}
          />
        ))}
      </nav>
      {current !== undefined && (
        <div
          className="cg-flyout"
          role="region"
          aria-label={current.title}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) {
              event.stopPropagation();
              setTab(null);
            }
          }}
        >
          <header className="cg-flyout__header">
            <h2 className="cg-flyout__title">{current.title}</h2>
            <button
              type="button"
              className="cg-icon-button"
              aria-label="Close panel"
              title="Close"
              onClick={() => {
                setTab(null);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </header>
          <div className="cg-flyout__body">
            {current.id === 'search' && <SearchTab {...search} inputRef={searchRef} />}

            {current.id === 'connections' && (
              <SidebarSection title="Show connections">
                <SwitchRow
                  label="Imports"
                  description="Between files"
                  leading={<LineSample variant="import" />}
                  checked={connections.imports}
                  onChange={(imports) => {
                    onConnectionsChange({ ...connections, imports });
                  }}
                />
                <SwitchRow
                  label="Calls"
                  description="Between functions of different files"
                  leading={<LineSample variant="call" />}
                  checked={connections.calls}
                  onChange={(calls) => {
                    onConnectionsChange({ ...connections, calls });
                  }}
                />
                <SwitchRow
                  label="Calls inside a file"
                  description={
                    connections.calls ? 'Between functions of the same file' : 'Turn on Calls first'
                  }
                  leading={<LineSample variant="internal" />}
                  checked={connections.calls && connections.internalCalls}
                  disabled={!connections.calls}
                  onChange={(internalCalls) => {
                    onConnectionsChange({ ...connections, internalCalls });
                  }}
                />
                <p className="cg-side-hint">
                  <strong>×n</strong> on a line: n connections merged into one by a collapsed file
                  or folder.
                </p>
              </SidebarSection>
            )}

            {current.id === 'filters' && (
              <FiltersTab
                filters={filters.filters}
                onChange={filters.onChange}
                folders={filters.folders}
                folderColors={filters.folderColors}
                workspaceFolders={filters.workspaceFolders}
                unused={filters.unused}
                hiddenFiles={filters.hiddenFiles}
                hiddenFunctions={filters.hiddenFunctions}
              />
            )}

            {current.id === 'focus' && (
              <>
                {focus.label === null ? (
                  <div className="cg-focus-card cg-focus-card--empty">
                    <Icon name="focus" size={20} />
                    <p>
                      <strong>Double-click</strong> or <strong>right-click</strong> a file or
                      function to see only its connections. While focusing, click another one to
                      move the focus.
                    </p>
                  </div>
                ) : (
                  <div className="cg-focus-card" title={focus.detail ?? focus.label}>
                    <Icon name="focus" size={20} />
                    <div className="cg-focus-card__text">
                      <span className="cg-focus-card__label">{focus.label}</span>
                      {focus.detail !== null && (
                        <span className="cg-focus-card__detail">{focus.detail}</span>
                      )}
                    </div>
                  </div>
                )}
                <SidebarSection title="Distance">
                  <Segmented
                    label="Focus depth"
                    options={DEPTH_OPTIONS}
                    value={focus.depth}
                    onChange={focus.onDepthChange}
                  />
                </SidebarSection>
                <SidebarSection title="Direction">
                  <Segmented
                    label="Focus direction"
                    options={DIRECTION_OPTIONS}
                    value={focus.direction}
                    onChange={focus.onDirectionChange}
                  />
                </SidebarSection>
                <div className="cg-button-row">
                  <button type="button" className="cg-button" onClick={focus.onFocusSelected}>
                    Focus selected
                  </button>
                  <button
                    type="button"
                    className="cg-button cg-button--secondary"
                    disabled={focus.label === null}
                    title="Leave focus mode (Escape)"
                    onClick={focus.onExit}
                  >
                    Exit focus
                  </button>
                </div>
              </>
            )}

            {current.id === 'review' && <ReviewTab {...reviewTab} />}
            {current.id === 'export' && <ExportTab {...exportTab} />}

            {current.id === 'view' && (
              <>
                <SidebarSection title="Layout">
                  <div className="cg-tiles">
                    <button
                      type="button"
                      className="cg-tile"
                      title="Open the next level: collapsed folders, or files when no folder is collapsed"
                      onClick={view.onExpandLevel}
                    >
                      <Icon name="expand" />
                      Expand level
                    </button>
                    <button type="button" className="cg-tile" onClick={view.onExpandAll}>
                      <Icon name="expandAll" />
                      Expand all
                    </button>
                    <button type="button" className="cg-tile" onClick={view.onCollapseAll}>
                      <Icon name="collapseAll" />
                      Collapse all
                    </button>
                    <button
                      type="button"
                      className="cg-tile"
                      title="Recompute the layout of every file"
                      onClick={view.onRelayout}
                    >
                      <Icon name="relayout" />
                      Re-layout
                    </button>
                  </div>
                </SidebarSection>
                <SidebarSection title="Display">
                  <SwitchRow
                    label="Follow the editor"
                    description="Highlight the file or function under the cursor"
                    checked={view.editorSync}
                    onChange={view.onEditorSyncChange}
                  />
                  <SwitchRow
                    label="Minimap"
                    description="Hidden automatically on large graphs"
                    checked={view.minimapShown}
                    onChange={view.onToggleMinimap}
                  />
                  <SwitchRow
                    label="Folder colors"
                    description="Color stripe by folder on files and folders"
                    checked={view.folderColorsEnabled}
                    onChange={view.onToggleFolderColors}
                  />
                </SidebarSection>
                {view.folderColorsEnabled && view.workspaceColors.length > 0 && (
                  <SidebarSection title="Color legend">
                    <ul className="cg-color-legend">
                      {view.workspaceColors.map((entry) => (
                        <li key={entry.root} className="cg-color-legend__group">
                          <div className="cg-color-legend__item" title={entry.root}>
                            <span
                              className="cg-color-legend__swatch"
                              style={{ background: entry.color }}
                            />
                            <span className="cg-color-legend__name cg-color-legend__name--root">
                              {entry.root}
                            </span>
                            <span className="cg-color-legend__count">{entry.fileCount}</span>
                          </div>
                          {entry.folders.length > 0 && (
                            <div
                              className="cg-color-legend__folders"
                              title={entry.folders.join(', ')}
                            >
                              {entry.folders.join(' · ')}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </SidebarSection>
                )}
                {view.folderColorsEnabled &&
                  view.workspaceColors.length === 0 &&
                  view.folderColors.length > 0 && (
                    <SidebarSection title="Color legend">
                      <ul className="cg-color-legend">
                        {view.folderColors.slice(0, MAX_LISTED_FOLDER_COLORS).map((entry) => (
                          <li
                            key={entry.folder}
                            className="cg-color-legend__item"
                            title={entry.folder}
                          >
                            <span
                              className="cg-color-legend__swatch"
                              style={{ background: entry.color }}
                            />
                            <span className="cg-color-legend__name">{entry.folder}</span>
                            <span className="cg-color-legend__count">{entry.fileCount}</span>
                          </li>
                        ))}
                        {view.folderColors.length > MAX_LISTED_FOLDER_COLORS && (
                          <li className="cg-side-hint">
                            +{view.folderColors.length - MAX_LISTED_FOLDER_COLORS} more folders
                          </li>
                        )}
                      </ul>
                    </SidebarSection>
                  )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
