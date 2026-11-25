/**
 * Export tab of the sidebar: what to export (everything, what is on screen
 * or chosen files and folders) and in which format (PNG, SVG, Mermaid).
 */
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import type { RelPath } from '../shared';
import type { SegmentOption } from './controls';
import { Segmented, SidebarSection } from './controls';
import type { ExportFormat, ExportScope, MermaidLevel } from './exportGraph';
import { MERMAID_NODE_WARNING } from './exportGraph';

/** An export asked by the user. */
export interface ExportRequest {
  readonly scope: ExportScope;
  readonly format: ExportFormat;
  readonly level: MermaidLevel;
  /** Chosen file and folder paths (scope `selected`). */
  readonly selection: readonly RelPath[];
  /** Copy the Mermaid text instead of saving it. */
  readonly copy: boolean;
}

/** A file or folder that can be chosen. */
export interface ExportItem {
  readonly path: RelPath;
  readonly kind: 'folder' | 'file';
  readonly fileCount: number;
}

/** Props of {@link ExportTab}. */
export interface ExportTabProps {
  /** Folders and files of the graph, folders first. */
  readonly items: readonly ExportItem[];
  /** Number of files and functions an export would contain. */
  readonly estimate: (request: ExportRequest) => {
    readonly files: number;
    readonly functions: number;
  };
  readonly onExport: (request: ExportRequest) => void;
  /** Whether an export is running. */
  readonly exporting: boolean;
}

/** Most rows listed at once; a search narrows larger lists. */
const MAX_LISTED_ITEMS = 200;

const SCOPE_OPTIONS: readonly SegmentOption<ExportScope>[] = [
  { value: 'all', label: 'Everything', title: 'The whole graph, as opened' },
  { value: 'view', label: 'On screen', title: 'What is visible on the canvas' },
  { value: 'selected', label: 'Selected', title: 'Chosen files and folders' },
];

const FORMAT_OPTIONS: readonly SegmentOption<ExportFormat>[] = [
  { value: 'png', label: 'PNG', title: 'Image' },
  { value: 'svg', label: 'SVG', title: 'Vector image (opens in browsers)' },
  { value: 'mermaid', label: 'Mermaid', title: 'Diagram text for READMEs and pull requests' },
];

const LEVEL_OPTIONS: readonly SegmentOption<MermaidLevel>[] = [
  { value: 'files', label: 'Files', title: 'Files grouped by folder' },
  { value: 'functions', label: 'Functions', title: 'Functions grouped by file' },
];

/**
 * Export tab.
 *
 * @param props - Files and folders, estimate and export callbacks.
 * @returns The tab content.
 */
export function ExportTab({ items, estimate, onExport, exporting }: ExportTabProps): JSX.Element {
  const [scope, setScope] = useState<ExportScope>('all');
  const [format, setFormat] = useState<ExportFormat>('png');
  const [level, setLevel] = useState<MermaidLevel>('files');
  const [selection, setSelection] = useState<readonly RelPath[]>([]);
  const [search, setSearch] = useState('');

  const request: ExportRequest = { scope, format, level, selection, copy: false };
  const size = estimate(request);
  const nodeCount = level === 'files' ? size.files : size.functions;
  const rows = useMemo(() => {
    const text = search.trim().toLowerCase();
    return items.filter((item) => text === '' || item.path.toLowerCase().includes(text));
  }, [items, search]);
  const empty = scope === 'selected' && selection.length === 0;

  /**
   * Adds or removes a file or folder from the selection.
   *
   * @param path - File or folder path.
   */
  const toggle = (path: RelPath): void => {
    setSelection((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  };

  return (
    <>
      <SidebarSection title="Content">
        <Segmented
          label="What to export"
          options={SCOPE_OPTIONS}
          value={scope}
          onChange={setScope}
        />
        {scope === 'selected' && (
          <div className="cg-export-picker">
            <input
              type="search"
              className="cg-input"
              placeholder="Find a file or folder…"
              aria-label="Find a file or folder"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
            <ul className="cg-export-list">
              {rows.slice(0, MAX_LISTED_ITEMS).map((item) => (
                <li key={`${item.kind}:${item.path}`}>
                  <label className="cg-export-item" title={item.path}>
                    <input
                      type="checkbox"
                      checked={selection.includes(item.path)}
                      onChange={() => {
                        toggle(item.path);
                      }}
                    />
                    <span className={`cg-export-item__name cg-export-item__name--${item.kind}`}>
                      {item.kind === 'folder' ? `${item.path}/` : item.path}
                    </span>
                    {item.kind === 'folder' && (
                      <span className="cg-export-item__count">{item.fileCount}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
            {rows.length > MAX_LISTED_ITEMS && (
              <p className="cg-side-hint">
                +{rows.length - MAX_LISTED_ITEMS} more: type to narrow the list.
              </p>
            )}
            {selection.length > 0 && (
              <button
                type="button"
                className="cg-link-button"
                onClick={() => {
                  setSelection([]);
                }}
              >
                Clear selection ({selection.length})
              </button>
            )}
          </div>
        )}
      </SidebarSection>

      <SidebarSection title="Format">
        <Segmented label="Format" options={FORMAT_OPTIONS} value={format} onChange={setFormat} />
        {format === 'mermaid' && (
          <Segmented label="Detail" options={LEVEL_OPTIONS} value={level} onChange={setLevel} />
        )}
        <p className="cg-side-hint">
          {size.files} files · {size.functions} functions
          {format === 'mermaid' && nodeCount > MERMAID_NODE_WARNING
            ? ` · large for Mermaid (over ${String(MERMAID_NODE_WARNING)} nodes)`
            : ''}
          {format !== 'mermaid' && scope !== 'view'
            ? ' · as opened on the canvas (open folders and files to include their content)'
            : ''}
        </p>
      </SidebarSection>

      <div className="cg-button-row">
        <button
          type="button"
          className="cg-button"
          disabled={exporting || empty}
          onClick={() => {
            onExport(request);
          }}
        >
          {exporting ? 'Exporting…' : 'Export…'}
        </button>
        {format === 'mermaid' && (
          <button
            type="button"
            className="cg-button cg-button--secondary"
            disabled={exporting || empty}
            onClick={() => {
              onExport({ ...request, copy: true });
            }}
          >
            Copy
          </button>
        )}
      </div>
    </>
  );
}
