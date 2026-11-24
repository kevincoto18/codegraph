import type { JSX, Ref } from 'react';

import { formatMatchCount } from './search';

/** Props of {@link SearchBox}. */
interface SearchBoxProps {
  /** Current query. */
  readonly value: string;
  /** Number of matches, or `null` when no search is active. */
  readonly matchCount: number | null;
  /** Called with the new query on every keystroke. */
  readonly onChange: (value: string) => void;
  /** Called when the user presses Enter (zoom to matches). */
  readonly onSubmit: () => void;
  /** Ref to the input, e.g. to focus it. */
  readonly inputRef?: Ref<HTMLInputElement>;
}

/**
 * Search input for files and functions. Enter zooms to the matches and
 * Escape clears the query.
 *
 * @param props - Query, match count and callbacks.
 * @returns The search box element.
 */
export function SearchBox({
  value,
  matchCount,
  onChange,
  onSubmit,
  inputRef,
}: SearchBoxProps): JSX.Element {
  return (
    <div className="cg-search">
      <input
        ref={inputRef}
        type="search"
        className="cg-search__input"
        placeholder="Search files or functions…"
        aria-label="Search files or functions"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onSubmit();
          } else if (event.key === 'Escape') {
            onChange('');
          }
        }}
      />
      {matchCount !== null && (
        <span className={`cg-search__count${matchCount === 0 ? ' cg-search__count--none' : ''}`}>
          {formatMatchCount(matchCount)}
        </span>
      )}
    </div>
  );
}
