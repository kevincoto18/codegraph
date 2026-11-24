import type { JSX, Ref } from 'react';
import { useEffect, useId, useRef } from 'react';

import { Icon } from './icons';
import { formatMatchCount } from './search';
import type { SearchHit } from './searchIndex';
import { splitHighlights } from './searchIndex';

/** Most results listed; the rest stay highlighted on the canvas. */
export const MAX_LISTED_RESULTS = 50;

/** Props of {@link SearchTab}. */
export interface SearchTabProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** Ranked results of the current query (all of them). */
  readonly hits: readonly SearchHit[];
  /** Index of the highlighted result in {@link hits}. */
  readonly activeIndex: number;
  /** Whether the active result has been shown on the canvas (counter "n of m"). */
  readonly visited: boolean;
  readonly onActiveIndexChange: (index: number) => void;
  /** Shows a result on the canvas (opens what hides it and centers it). */
  readonly onGoTo: (index: number) => void;
  /** Opens a result in the editor. */
  readonly onOpen: (index: number) => void;
  /** Moves to the next (`1`) or previous (`-1`) result and shows it. */
  readonly onStep: (delta: 1 | -1) => void;
  /** Zooms out to show every result at once. */
  readonly onShowAll: () => void;
  /** Ref to the input, to focus it when the tab opens. */
  readonly inputRef?: Ref<HTMLInputElement>;
}

/**
 * "Search" tab of the sidebar: fuzzy search box, ranked result list and
 * keyboard navigation (↑/↓ select, Enter shows on the canvas, Ctrl+Enter
 * opens the code, Shift+Enter / F3 / Shift+F3 move between results, Escape
 * clears).
 *
 * @param props - Query, results and callbacks.
 * @returns The tab content.
 */
export function SearchTab({
  query,
  onQueryChange,
  hits,
  activeIndex,
  visited,
  onActiveIndexChange,
  onGoTo,
  onOpen,
  onStep,
  onShowAll,
  inputRef,
}: SearchTabProps): JSX.Element {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const listed = hits.slice(0, MAX_LISTED_RESULTS);
  const searching = query.trim() !== '';

  // Keep the active result visible while moving with the keyboard.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${String(activeIndex)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const count = !searching
    ? null
    : visited && hits.length > 0
      ? `${String(activeIndex + 1)} of ${String(hits.length)}`
      : formatMatchCount(hits.length);

  return (
    <>
      <div className="cg-search">
        <span className="cg-search__icon" aria-hidden="true">
          <Icon name="search" size={14} />
        </span>
        <input
          ref={inputRef}
          type="search"
          className="cg-search__input"
          placeholder="Search files or functions…"
          aria-label="Search files or functions"
          role="combobox"
          aria-expanded={listed.length > 0}
          aria-controls={listId}
          aria-activedescendant={listed.length > 0 ? `${listId}-${String(activeIndex)}` : undefined}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (listed.length > 0) {
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                onActiveIndexChange((activeIndex + delta + listed.length) % listed.length);
              }
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (event.ctrlKey || event.metaKey) {
                onOpen(activeIndex);
              } else if (event.shiftKey) {
                onStep(-1);
              } else {
                onGoTo(activeIndex);
              }
            } else if (event.key === 'Escape') {
              onQueryChange('');
            }
          }}
        />
        {count !== null && (
          <span
            className={`cg-search__count${hits.length === 0 ? ' cg-search__count--none' : ''}`}
            role="status"
          >
            {count}
          </span>
        )}
        <button
          type="button"
          className="cg-icon-button"
          aria-label="Previous result (Shift+F3)"
          title="Previous result (Shift+F3)"
          disabled={hits.length === 0}
          onClick={() => {
            onStep(-1);
          }}
        >
          <Icon name="chevronUp" size={14} />
        </button>
        <button
          type="button"
          className="cg-icon-button"
          aria-label="Next result (F3)"
          title="Next result (F3)"
          disabled={hits.length === 0}
          onClick={() => {
            onStep(1);
          }}
        >
          <Icon name="chevronDown" size={14} />
        </button>
      </div>

      {!searching ? (
        <p className="cg-side-hint">
          Fuzzy search: <code>gvc</code> finds <code>GraphViewContent</code>, several words must all
          match. <kbd>↑</kbd>
          <kbd>↓</kbd> choose · <kbd>Enter</kbd> show in the graph · <kbd>Ctrl</kbd>+
          <kbd>Enter</kbd> open the code · <kbd>F3</kbd> next.
        </p>
      ) : hits.length === 0 ? (
        <p className="cg-side-hint">No file or function matches “{query.trim()}”.</p>
      ) : (
        <>
          <ul id={listId} ref={listRef} className="cg-results" role="listbox">
            {listed.map((hit, index) => (
              <li
                key={hit.entry.id}
                id={`${listId}-${String(index)}`}
                data-index={index}
                role="option"
                aria-selected={index === activeIndex}
                className="cg-result"
                title={`${hit.entry.name} — ${hit.entry.detail || '(workspace root)'}`}
                onMouseMove={() => {
                  if (index !== activeIndex) {
                    onActiveIndexChange(index);
                  }
                }}
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey) {
                    onOpen(index);
                  } else {
                    onGoTo(index);
                  }
                }}
                onDoubleClick={() => {
                  onOpen(index);
                }}
              >
                <span className={`cg-result__kind cg-result__kind--${hit.entry.kind}`}>
                  {hit.entry.kind === 'file' ? 'F' : 'ƒ'}
                </span>
                <span className="cg-result__text">
                  <span className="cg-result__name">
                    {splitHighlights(hit.entry.name, hit.positions).map((segment, part) =>
                      segment.highlighted ? (
                        <mark key={part}>{segment.text}</mark>
                      ) : (
                        <span key={part}>{segment.text}</span>
                      ),
                    )}
                  </span>
                  <span className="cg-result__detail">{hit.entry.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="cg-results__footer">
            <span>
              {hits.length > MAX_LISTED_RESULTS
                ? `Top ${String(MAX_LISTED_RESULTS)} of ${String(hits.length)}`
                : ''}
            </span>
            <button type="button" className="cg-link-button" onClick={onShowAll}>
              Show all in the graph
            </button>
          </div>
        </>
      )}
    </>
  );
}
