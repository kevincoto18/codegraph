import type { JSX } from 'react';

import type { AnalysisState } from '../shared';
import type { GraphSummary } from './graphChannel';

/** Props of {@link StatusBar}. */
interface StatusBarProps {
  readonly status: AnalysisState;
  readonly errorMessage: string | null;
  /** Graph counters, when a graph is loaded. */
  readonly summary: GraphSummary | null;
  /** Requests a full rescan. */
  readonly onRefresh: () => void;
}

/**
 * Builds the status text shown in the toolbar.
 *
 * @param status - Analysis status.
 * @param errorMessage - Error text, if any.
 * @param summary - Graph counters, if loaded.
 * @returns Human-readable status.
 */
export function formatStatus(
  status: AnalysisState,
  errorMessage: string | null,
  summary: GraphSummary | null,
): string {
  if (status === 'analyzing') {
    return 'Analyzing workspace…';
  }
  if (status === 'error') {
    return `Analysis failed: ${errorMessage ?? 'unknown error'}`;
  }
  if (summary === null) {
    return 'No graph loaded.';
  }
  const { files, functions, imports, calls } = summary;
  return `${String(files)} files · ${String(functions)} functions · ${String(imports)} imports · ${String(calls)} calls`;
}

/**
 * Toolbar with the analysis status, graph counters and a refresh button.
 *
 * @param props - Status, counters and refresh callback.
 * @returns The toolbar element.
 */
export function StatusBar({
  status,
  errorMessage,
  summary,
  onRefresh,
}: StatusBarProps): JSX.Element {
  return (
    <header className={`cg-toolbar cg-toolbar--${status}`}>
      <span className="cg-toolbar__title">CodeGraph</span>
      <span className="cg-toolbar__status" role="status">
        {formatStatus(status, errorMessage, summary)}
      </span>
      <button
        type="button"
        className="cg-toolbar__button"
        onClick={onRefresh}
        disabled={status === 'analyzing'}
      >
        Refresh
      </button>
    </header>
  );
}
