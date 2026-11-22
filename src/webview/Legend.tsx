import type { JSX } from 'react';

/** Props of {@link Legend}. */
interface LegendProps {
  /** Whether edges are currently skipped because the canvas is zoomed out. */
  readonly edgesHidden: boolean;
}

/**
 * Explains the edge styles: dashed purple imports and solid blue calls.
 *
 * @param props - Whether edges are hidden at this zoom.
 * @returns The legend element.
 */
export function Legend({ edgesHidden }: LegendProps): JSX.Element {
  return (
    <div className="cg-legend" aria-label="Legend">
      <div className="cg-legend__row">
        <svg className="cg-legend__line" viewBox="0 0 28 8" aria-hidden="true">
          <line className="cg-legend__import" x1="0" y1="4" x2="28" y2="4" />
        </svg>
        Import (file → file)
      </div>
      <div className="cg-legend__row">
        <svg className="cg-legend__line" viewBox="0 0 28 8" aria-hidden="true">
          <line className="cg-legend__call" x1="0" y1="4" x2="28" y2="4" />
        </svg>
        Call (function → function)
      </div>
      <div className="cg-legend__row">
        <span className="cg-legend__count">×n</span>n connections merged (collapsed file or folder)
      </div>
      {edgesHidden && (
        <div className="cg-legend__row cg-legend__hint">Zoom in to see the connections</div>
      )}
    </div>
  );
}
