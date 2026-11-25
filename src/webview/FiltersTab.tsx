import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import type { NodeFilters, RelPath } from '../shared';
import { MAX_EXCLUDE_PATTERNS } from '../shared';
import { SidebarSection, SwitchRow } from './controls';
import type { WorkspaceColorEntry } from './folderColors';
import { Icon } from './icons';
import { formatFileCount } from './nodes/FolderNode';
import type { FolderEntry } from './nodeFilters';
import {
  compileExcludePattern,
  countActiveNodeFilters,
  folderHiddenState,
  toggleHiddenFolder,
} from './nodeFilters';

/** Most folders listed at once; a search narrows larger lists. */
const MAX_LISTED_FOLDERS = 200;

/** Props of {@link FiltersTab}. */
interface FiltersTabProps {
  readonly filters: NodeFilters;
  readonly onChange: (filters: NodeFilters) => void;
  /** Every folder of the workspace (also the hidden ones). */
  readonly folders: readonly FolderEntry[];
  /** Color of each folder that directly contains files. */
  readonly folderColors: ReadonlyMap<RelPath, string>;
  /** Workspace folders with their colors (multi-root); empty with one folder. */
  readonly workspaceFolders: readonly WorkspaceColorEntry[];
  /** Files hidden by the filters. */
  readonly hiddenFiles: number;
  /** Functions hidden by the filters. */
  readonly hiddenFunctions: number;
}

/**
 * Chooses the folders to list: the expanded branches of the tree, or every
 * folder whose path contains the search text.
 *
 * @param folders - All folders, parents before children.
 * @param expanded - Folders whose children are shown.
 * @param search - Folder search text.
 * @returns The rows to render.
 */
function visibleFolderRows(
  folders: readonly FolderEntry[],
  expanded: ReadonlySet<RelPath>,
  search: string,
): FolderEntry[] {
  const needle = search.trim().toLowerCase();
  if (needle !== '') {
    return folders.filter((folder) => folder.path.toLowerCase().includes(needle));
  }
  return folders.filter((folder) => {
    const segments = folder.path.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      if (!expanded.has(segments.slice(0, length).join('/'))) {
        return false;
      }
    }
    return true;
  });
}

/**
 * "Filters" tab of the sidebar: quick toggles (tests, exported only), a
 * folder tree with show/hide buttons and custom exclude patterns.
 *
 * @param props - Current filters, folders and callbacks.
 * @returns The tab content.
 */
export function FiltersTab({
  filters,
  onChange,
  folders,
  folderColors,
  workspaceFolders,
  hiddenFiles,
  hiddenFunctions,
}: FiltersTabProps): JSX.Element {
  const [folderSearch, setFolderSearch] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<RelPath>>(new Set());
  const [patternDraft, setPatternDraft] = useState('');
  const hasChildren = useMemo(() => {
    const parents = new Set<RelPath>();
    for (const folder of folders) {
      const slash = folder.path.lastIndexOf('/');
      if (slash > 0) {
        parents.add(folder.path.slice(0, slash));
      }
    }
    return parents;
  }, [folders]);
  const rows = useMemo(
    () => visibleFolderRows(folders, expanded, folderSearch),
    [folders, expanded, folderSearch],
  );
  const searching = folderSearch.trim() !== '';
  const activeCount = countActiveNodeFilters(filters);
  const draft = patternDraft.trim();
  const draftInvalid =
    draft !== '' &&
    (compileExcludePattern(draft) === null || filters.excludePatterns.includes(draft));
  const canAddPattern =
    draft !== '' && !draftInvalid && filters.excludePatterns.length < MAX_EXCLUDE_PATTERNS;

  /** Adds the drafted exclude pattern. */
  const addPattern = (): void => {
    if (!canAddPattern) {
      return;
    }
    onChange({ ...filters, excludePatterns: [...filters.excludePatterns, draft] });
    setPatternDraft('');
  };

  /**
   * Opens or closes a branch of the folder tree.
   *
   * @param path - Folder to toggle.
   */
  const toggleExpanded = (path: RelPath): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <>
      <div className={`cg-filter-summary${activeCount > 0 ? ' cg-filter-summary--active' : ''}`}>
        <span>
          {activeCount === 0
            ? 'Everything is visible'
            : `${String(hiddenFiles)} files · ${String(hiddenFunctions)} functions hidden`}
        </span>
        {activeCount > 0 && (
          <button
            type="button"
            className="cg-link-button"
            onClick={() => {
              onChange({
                hideTests: false,
                exportedOnly: false,
                hiddenFolders: [],
                excludePatterns: [],
              });
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {workspaceFolders.length > 0 && (
        <SidebarSection title="Workspace folders">
          {workspaceFolders.map((entry) => (
            <SwitchRow
              key={entry.root}
              label={entry.root}
              description={formatFileCount(entry.fileCount)}
              leading={<span className="cg-root-swatch" style={{ background: entry.color }} />}
              checked={!filters.hiddenFolders.includes(entry.root)}
              onChange={() => {
                onChange({
                  ...filters,
                  hiddenFolders: toggleHiddenFolder(filters.hiddenFolders, entry.root),
                });
              }}
            />
          ))}
        </SidebarSection>
      )}

      <SidebarSection title="Quick filters">
        <SwitchRow
          label="Hide tests"
          description="*.test.*, *.spec.*, test_*.py, __tests__/"
          checked={filters.hideTests}
          onChange={(hideTests) => {
            onChange({ ...filters, hideTests });
          }}
        />
        <SwitchRow
          label="Only exported functions"
          description="Hide private and internal helpers"
          checked={filters.exportedOnly}
          onChange={(exportedOnly) => {
            onChange({ ...filters, exportedOnly });
          }}
        />
      </SidebarSection>

      <SidebarSection
        title="Folders"
        action={
          filters.hiddenFolders.length > 0 ? (
            <button
              type="button"
              className="cg-link-button"
              onClick={() => {
                onChange({ ...filters, hiddenFolders: [] });
              }}
            >
              Show all
            </button>
          ) : undefined
        }
      >
        <input
          type="search"
          className="cg-input"
          placeholder="Find a folder…"
          aria-label="Find a folder"
          value={folderSearch}
          onChange={(event) => {
            setFolderSearch(event.target.value);
          }}
        />
        {folders.length === 0 ? (
          <p className="cg-side-hint">All files are at the workspace root.</p>
        ) : (
          <ul className="cg-folder-tree" aria-label="Folders">
            {rows.slice(0, MAX_LISTED_FOLDERS).map((folder) => {
              const hidden = folderHiddenState(filters.hiddenFolders, folder.path);
              const open = expanded.has(folder.path);
              const color = folderColors.get(folder.path);
              return (
                <li
                  key={folder.path}
                  className={`cg-folder-row${hidden === null ? '' : ' cg-folder-row--hidden'}`}
                  style={{ paddingLeft: searching ? 4 : 4 + folder.depth * 14 }}
                  title={folder.path}
                >
                  {!searching && hasChildren.has(folder.path) ? (
                    <button
                      type="button"
                      className="cg-icon-button cg-icon-button--small"
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.path}`}
                      aria-expanded={open}
                      onClick={() => {
                        toggleExpanded(folder.path);
                      }}
                    >
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                    </button>
                  ) : (
                    <span className="cg-folder-row__spacer" />
                  )}
                  <span
                    className="cg-folder-row__swatch"
                    style={color === undefined ? undefined : { background: color }}
                  />
                  <span className="cg-folder-row__name">
                    {searching ? folder.path : folder.name}
                  </span>
                  <span className="cg-folder-row__count">{folder.fileCount}</span>
                  <button
                    type="button"
                    className="cg-icon-button cg-folder-row__toggle"
                    aria-pressed={hidden !== null}
                    disabled={hidden === 'parent'}
                    aria-label={`${hidden === null ? 'Hide' : 'Show'} ${folder.path}`}
                    title={
                      hidden === 'parent'
                        ? 'Hidden with its parent folder'
                        : hidden === 'self'
                          ? 'Show this folder'
                          : 'Hide this folder'
                    }
                    onClick={() => {
                      onChange({
                        ...filters,
                        hiddenFolders: toggleHiddenFolder(filters.hiddenFolders, folder.path),
                      });
                    }}
                  >
                    <Icon name={hidden === null ? 'eye' : 'eyeOff'} size={14} />
                  </button>
                </li>
              );
            })}
            {rows.length > MAX_LISTED_FOLDERS && (
              <li className="cg-side-hint">
                {rows.length - MAX_LISTED_FOLDERS} more — type to narrow the list
              </li>
            )}
            {rows.length === 0 && <li className="cg-side-hint">No folder matches.</li>}
          </ul>
        )}
      </SidebarSection>

      <SidebarSection title="Exclude patterns">
        <form
          className="cg-pattern-form"
          onSubmit={(event) => {
            event.preventDefault();
            addPattern();
          }}
        >
          <input
            type="text"
            className={`cg-input${draftInvalid ? ' cg-input--invalid' : ''}`}
            placeholder="e.g. **/generated/** or *.gen.ts"
            aria-label="New exclude pattern"
            value={patternDraft}
            onChange={(event) => {
              setPatternDraft(event.target.value);
            }}
          />
          <button type="submit" className="cg-button" disabled={!canAddPattern}>
            Add
          </button>
        </form>
        {filters.excludePatterns.length > 0 && (
          <ul className="cg-chips" aria-label="Exclude patterns">
            {filters.excludePatterns.map((pattern) => (
              <li key={pattern} className="cg-chip">
                <code className="cg-chip__text">{pattern}</code>
                <button
                  type="button"
                  className="cg-chip__remove"
                  aria-label={`Remove ${pattern}`}
                  onClick={() => {
                    onChange({
                      ...filters,
                      excludePatterns: filters.excludePatterns.filter((item) => item !== pattern),
                    });
                  }}
                >
                  <Icon name="close" size={10} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SidebarSection>
    </>
  );
}
