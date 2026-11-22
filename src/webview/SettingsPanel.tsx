import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

import type { EdgeFilters } from './edgeFilters';
import type { FolderColorEntry } from './folderColors';
import { SearchBox } from './SearchBox';

/** Most folders listed in the color legend. */
const MAX_LISTED_FOLDERS = 12;

/** Props of {@link SettingsPanel}. */
interface SettingsPanelProps {
  /** Current search query. */
  readonly query: string;
  /** Number of matches, or `null` without search. */
  readonly matchCount: number | null;
  readonly onQueryChange: (query: string) => void;
  /** Zooms to (and reveals) the matches. */
  readonly onSearchSubmit: () => void;
  readonly edgeFilters: EdgeFilters;
  readonly onToggleEdgeFilter: (key: keyof EdgeFilters) => void;
  readonly onExpandLevel: () => void;
  readonly onExpandAll: () => void;
  readonly onCollapseAll: () => void;
  readonly onRelayout: () => void;
  readonly minimapShown: boolean;
  readonly onToggleMinimap: () => void;
  readonly folderColorsEnabled: boolean;
  readonly onToggleFolderColors: () => void;
  /** Folders and their colors, largest first. */
  readonly folderColors: readonly FolderColorEntry[];
}

/** Props of {@link PanelSection}. */
interface PanelSectionProps {
  readonly title: string;
  /** Whether the section starts open. */
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}

/**
 * Collapsible section of the settings panel.
 *
 * @param props - Title, initial state and content.
 * @returns The section element.
 */
function PanelSection({ title, defaultOpen, children }: PanelSectionProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="cg-panel__section">
      <button
        type="button"
        className="cg-panel__section-header"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div className="cg-panel__section-body">{children}</div>}
    </section>
  );
}

/** Props of {@link ToggleButton}. */
interface ToggleButtonProps {
  readonly label: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
  readonly title?: string;
  readonly disabled?: boolean;
}

/**
 * On/off button of the panel.
 *
 * @param props - Label, state and callback.
 * @returns The button element.
 */
function ToggleButton({
  label,
  pressed,
  onToggle,
  title,
  disabled = false,
}: ToggleButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="cg-toolbar__button"
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

/**
 * Floating settings and filters panel: search, connection filters, view
 * actions and folder colors, in collapsible sections. It can be minimized to
 * a single button so it never hides the graph.
 *
 * @param props - Current settings and callbacks.
 * @returns The panel element.
 */
export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const [minimized, setMinimized] = useState(false);
  if (minimized) {
    return (
      <div className="cg-panel cg-panel--minimized nowheel">
        <button
          type="button"
          className="cg-toolbar__button"
          aria-label="Show settings and filters"
          title="Show settings and filters"
          onClick={() => {
            setMinimized(false);
          }}
        >
          ☰ Settings
        </button>
      </div>
    );
  }
  const { edgeFilters, onToggleEdgeFilter } = props;
  return (
    <div className="cg-panel nowheel" aria-label="Settings and filters">
      <div className="cg-panel__header">
        <span className="cg-panel__title">Settings &amp; filters</span>
        <button
          type="button"
          className="cg-panel__minimize"
          aria-label="Minimize settings and filters"
          title="Minimize"
          onClick={() => {
            setMinimized(true);
          }}
        >
          –
        </button>
      </div>

      <PanelSection title="Search" defaultOpen>
        <SearchBox
          value={props.query}
          matchCount={props.matchCount}
          onChange={props.onQueryChange}
          onSubmit={props.onSearchSubmit}
        />
      </PanelSection>

      <PanelSection title="Connections" defaultOpen>
        <div className="cg-panel__row">
          <ToggleButton
            label="Imports"
            pressed={edgeFilters.imports}
            title="Imports between files (dashed purple lines)"
            onToggle={() => {
              onToggleEdgeFilter('imports');
            }}
          />
          <ToggleButton
            label="Calls"
            pressed={edgeFilters.calls}
            title="Calls between functions (solid blue lines)"
            onToggle={() => {
              onToggleEdgeFilter('calls');
            }}
          />
          <ToggleButton
            label="Internal calls"
            pressed={edgeFilters.calls && edgeFilters.internalCalls}
            disabled={!edgeFilters.calls}
            title="Calls between functions of the same file"
            onToggle={() => {
              onToggleEdgeFilter('internalCalls');
            }}
          />
        </div>
      </PanelSection>

      <PanelSection title="View" defaultOpen={false}>
        <div className="cg-panel__row">
          <button
            type="button"
            className="cg-toolbar__button"
            title="Open the next level: collapsed folders, or files when no folder is collapsed"
            onClick={props.onExpandLevel}
          >
            Expand level
          </button>
          <button type="button" className="cg-toolbar__button" onClick={props.onExpandAll}>
            Expand all
          </button>
          <button type="button" className="cg-toolbar__button" onClick={props.onCollapseAll}>
            Collapse all
          </button>
          <button
            type="button"
            className="cg-toolbar__button"
            title="Recompute the layout of every file"
            onClick={props.onRelayout}
          >
            Re-layout
          </button>
          <ToggleButton
            label="Minimap"
            pressed={props.minimapShown}
            title="Show or hide the minimap (hidden automatically on large graphs)"
            onToggle={props.onToggleMinimap}
          />
        </div>
      </PanelSection>

      <PanelSection title="Folders" defaultOpen={false}>
        <div className="cg-panel__row">
          <ToggleButton
            label="Folder colors"
            pressed={props.folderColorsEnabled}
            title="Color stripe by folder on files and folders"
            onToggle={props.onToggleFolderColors}
          />
        </div>
        {props.folderColorsEnabled && (
          <ul className="cg-panel__folders">
            {props.folderColors.slice(0, MAX_LISTED_FOLDERS).map((entry) => (
              <li key={entry.folder} className="cg-panel__folder" title={entry.folder}>
                <span className="cg-panel__swatch" style={{ background: entry.color }} />
                <span className="cg-panel__folder-name">{entry.folder}</span>
                <span className="cg-panel__folder-count">{entry.fileCount}</span>
              </li>
            ))}
            {props.folderColors.length > MAX_LISTED_FOLDERS && (
              <li className="cg-panel__more">
                +{props.folderColors.length - MAX_LISTED_FOLDERS} more folders
              </li>
            )}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}
