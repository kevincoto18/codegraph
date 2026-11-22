import type { JSX } from 'react';

/**
 * Compact, inline legend of the edge styles shown in the toolbar: dashed
 * purple imports, solid blue calls and merged `×n` edges.
 *
 * @returns The legend element.
 */
export function Legend(): JSX.Element {
  return (
    <div className="cg-legend" aria-label="Legend">
      <span className="cg-legend__item" title="Import between files">
        <svg className="cg-legend__line" viewBox="0 0 28 8" aria-hidden="true">
          <line className="cg-legend__import" x1="0" y1="4" x2="28" y2="4" />
        </svg>
        Import
      </span>
      <span className="cg-legend__item" title="Call between functions">
        <svg className="cg-legend__line" viewBox="0 0 28 8" aria-hidden="true">
          <line className="cg-legend__call" x1="0" y1="4" x2="28" y2="4" />
        </svg>
        Call
      </span>
      <span
        className="cg-legend__item"
        title="n connections merged into one (collapsed file or folder)"
      >
        <span className="cg-legend__count">×n</span>
        Merged
      </span>
    </div>
  );
}
