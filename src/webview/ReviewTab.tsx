/**
 * "Changes" tab of the sidebar: reviews the git changes of the workspace and
 * their impact on the graph (PR review mode).
 */
import type { JSX } from 'react';
import { useState } from 'react';

import type { ReviewFile, ReviewMode, ReviewState } from '../shared';
import type { SegmentOption } from './controls';
import { Segmented, SidebarSection } from './controls';
import { Icon } from './icons';
import type { ReviewEntry, ReviewImpact } from './review';
import { REVIEW_DEPTHS } from './review';

/** Props of {@link ReviewTab}. */
export interface ReviewTabProps {
  /** Review running, or `null` when none is. */
  readonly state: ReviewState | null;
  /** Branches the base can be picked from. */
  readonly branches: readonly string[];
  /** Picked base branch; empty to detect it. */
  readonly branch: string;
  readonly depth: number;
  readonly onDepthChange: (depth: number) => void;
  /** Starts or refreshes a review, or stops it with `null`; `branch` picks the base. */
  readonly onRequest: (mode: ReviewMode | null, branch?: string) => void;
  /** Changed functions and files, riskiest first. */
  readonly entries: readonly ReviewEntry[];
  readonly impact: ReviewImpact | null;
  /** Changed files that are not in the graph. */
  readonly outside: readonly ReviewFile[];
  /** Shows a node on the canvas. */
  readonly onGoTo: (nodeId: string) => void;
  /** Opens a node's code in the editor. */
  readonly onOpen: (nodeId: string) => void;
  readonly onCopySummary: () => void;
}

/** Most rows listed (the rest is in the summary count). */
const MAX_LISTED_ENTRIES = 200;

/** Options of the comparison selector. */
const MODE_OPTIONS: readonly SegmentOption<ReviewMode>[] = [
  {
    value: 'base',
    label: 'Base branch',
    title: 'Everything since the branch started (what the pull request will contain)',
  },
  { value: 'uncommitted', label: 'Uncommitted', title: 'Changes not committed yet' },
  { value: 'lastCommit', label: 'Last commit', title: 'The last commit plus uncommitted changes' },
];

/** Options of the depth selector. */
const DEPTH_OPTIONS: readonly SegmentOption<number>[] = REVIEW_DEPTHS.map((depth) => ({
  value: depth,
  label: depth === 1 ? 'Direct' : `${String(depth)} levels`,
  title:
    depth === 1
      ? 'Only what calls or imports the changes'
      : `Callers and importers up to ${String(depth)} levels away`,
}));

/** Labels of the file statuses. */
const STATUS_LABELS: Readonly<Record<ReviewFile['status'], string>> = {
  modified: 'modified',
  added: 'new',
  deleted: 'deleted',
  renamed: 'renamed',
};

/**
 * Line counts of a change.
 *
 * @param props - Added and removed lines.
 * @returns The counts.
 */
function LineCounts({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="cg-review-lines">
      {added > 0 && <span className="cg-review-lines__added">+{added}</span>}
      {removed > 0 && <span className="cg-review-lines__removed">−{removed}</span>}
    </span>
  );
}

/**
 * The Changes tab.
 *
 * @param props - Review state, list and callbacks.
 * @returns The tab content.
 */
export function ReviewTab({
  state,
  branches,
  branch,
  depth,
  onDepthChange,
  onRequest,
  entries,
  impact,
  outside,
  onGoTo,
  onOpen,
  onCopySummary,
}: ReviewTabProps): JSX.Element {
  const [showOutside, setShowOutside] = useState(false);

  if (state === null) {
    return (
      <div className="cg-review-intro">
        <div className="cg-review-intro__icon">
          <Icon name="gitCompare" size={22} />
        </div>
        <p className="cg-review-intro__title">Review your changes</p>
        <p className="cg-side-hint">
          See which functions your branch changes and everything that calls or imports them, before
          you open a pull request.
        </p>
        <div className="cg-button-row">
          <button
            type="button"
            className="cg-button"
            onClick={() => {
              onRequest('base');
            }}
          >
            Review changes
          </button>
        </div>
      </div>
    );
  }

  const mode = state.status === 'ready' ? state.result.mode : state.mode;
  const result = state.status === 'ready' ? state.result : null;

  return (
    <>
      <SidebarSection
        title="Compare with"
        action={
          <button
            type="button"
            className="cg-icon-button cg-icon-button--small"
            aria-label="Read the changes again"
            title="Read the changes again"
            onClick={() => {
              onRequest(mode);
            }}
          >
            <Icon name="sync" size={12} />
          </button>
        }
      >
        <Segmented
          label="Compare with"
          options={MODE_OPTIONS}
          value={mode}
          onChange={(next) => {
            onRequest(next);
          }}
        />
        {mode === 'base' && (
          <label className="cg-review-branch">
            <span className="cg-review-branch__label">Branch</span>
            <select
              className="cg-select"
              value={branch}
              onChange={(event) => {
                onRequest('base', event.target.value);
              }}
            >
              <option value="">Automatic (main, master or develop)</option>
              {branch !== '' && !branches.includes(branch) && (
                <option value={branch}>{branch}</option>
              )}
              {branches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="cg-side-hint">
          {state.status === 'loading'
            ? 'Reading changes…'
            : result === null
              ? null
              : `Against ${result.base}`}
        </p>
      </SidebarSection>

      {state.status === 'unavailable' && (
        <div className="cg-review-problem" role="alert">
          <Icon name="close" size={14} />
          <span>{state.message}</span>
        </div>
      )}

      {result !== null && impact !== null && (
        <>
          <SidebarSection title="Impact">
            <Segmented
              label="Impact depth"
              options={DEPTH_OPTIONS}
              value={depth}
              onChange={onDepthChange}
            />
            <div className="cg-review-stats">
              <div className="cg-review-stat cg-review-stat--changed">
                <span className="cg-review-stat__value">{impact.changed}</span>
                <span className="cg-review-stat__label">changed</span>
              </div>
              <div className="cg-review-stat cg-review-stat--affected">
                <span className="cg-review-stat__value">{impact.affected}</span>
                <span className="cg-review-stat__label">affected</span>
              </div>
              <div className="cg-review-stat">
                <span className="cg-review-stat__value">{result.files.length}</span>
                <span className="cg-review-stat__label">files</span>
              </div>
            </div>
            <div className="cg-review-legend" aria-hidden="true">
              <span className="cg-review-legend__item cg-review-legend__item--changed">
                changed
              </span>
              <span className="cg-review-legend__item cg-review-legend__item--direct">uses it</span>
              <span className="cg-review-legend__item cg-review-legend__item--indirect">
                indirect
              </span>
            </div>
          </SidebarSection>

          <SidebarSection title="Riskiest first">
            {entries.length === 0 ? (
              <p className="cg-side-hint">
                {result.files.length === 0
                  ? 'No changes: the working tree matches.'
                  : 'No analyzed code changed.'}
              </p>
            ) : (
              <ul className="cg-review-list">
                {entries.slice(0, MAX_LISTED_ENTRIES).map((entry) => (
                  <li key={entry.nodeId} className="cg-review-row">
                    <button
                      type="button"
                      className="cg-review-row__main"
                      title={`${entry.filePath}\nShow on the graph`}
                      onClick={() => {
                        onGoTo(entry.nodeId);
                      }}
                    >
                      <span className="cg-review-row__name">
                        <span className={`cg-review-row__kind cg-review-row__kind--${entry.kind}`}>
                          {entry.kind === 'function' ? 'ƒ' : '{ }'}
                        </span>
                        {entry.label}
                      </span>
                      <span className="cg-review-row__detail">
                        <span className="cg-review-row__path">{entry.filePath}</span>
                        <LineCounts added={entry.added} removed={entry.removed} />
                      </span>
                    </button>
                    <span
                      className={`cg-review-row__risk${entry.affected === 0 ? ' is-zero' : ''}`}
                      title={`${String(entry.affected)} functions or files use it (within ${String(depth)} ${depth === 1 ? 'level' : 'levels'})`}
                    >
                      {entry.affected}
                    </span>
                    <button
                      type="button"
                      className="cg-icon-button cg-icon-button--small"
                      aria-label={`Open ${entry.label} in the editor`}
                      title="Go to code"
                      onClick={() => {
                        onOpen(entry.nodeId);
                      }}
                    >
                      <Icon name="openFile" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {outside.length > 0 && (
              <>
                <button
                  type="button"
                  className="cg-link-button"
                  aria-expanded={showOutside}
                  onClick={() => {
                    setShowOutside((shown) => !shown);
                  }}
                >
                  {showOutside ? 'Hide' : 'Show'} {outside.length} not analyzed{' '}
                  {outside.length === 1 ? 'file' : 'files'}
                </button>
                {showOutside && (
                  <ul className="cg-review-outside">
                    {outside.map((file) => (
                      <li key={file.filePath} title={file.filePath}>
                        <span className="cg-review-outside__path">{file.filePath}</span>
                        <span className="cg-review-outside__status">
                          {STATUS_LABELS[file.status]}
                        </span>
                        <LineCounts added={file.added} removed={file.removed} />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {result.truncated && (
              <p className="cg-side-hint">Too many changed files: only the first 500 are shown.</p>
            )}
          </SidebarSection>
        </>
      )}

      <div className="cg-button-row">
        <button
          type="button"
          className="cg-button"
          disabled={result === null}
          title="Copy a Markdown summary for the pull request description"
          onClick={onCopySummary}
        >
          Copy summary
        </button>
        <button
          type="button"
          className="cg-button cg-button--secondary"
          onClick={() => {
            onRequest(null);
          }}
        >
          Stop review
        </button>
      </div>
    </>
  );
}
