/**
 * Bar shown over the canvas while picking or showing a path between two
 * nodes ("How does A reach B?").
 */
import type { JSX } from 'react';

/** One node of the shown path. */
export interface PathBarStep {
  readonly id: string;
  readonly label: string;
}

/** What the bar shows. */
export type PathBarState =
  | { readonly kind: 'picking'; readonly origin: string }
  | {
      readonly kind: 'found';
      readonly steps: readonly PathBarStep[];
      readonly reversed: boolean;
      readonly level: 'function' | 'file';
    }
  | { readonly kind: 'none'; readonly from: string; readonly to: string };

/** Props of {@link PathBar}. */
interface PathBarProps {
  readonly state: PathBarState;
  /** Shows a node of the path on the canvas. */
  readonly onStep: (nodeId: string) => void;
  /** Leaves path mode. */
  readonly onClose: () => void;
}

/**
 * Path bar: the destination prompt, the steps of the found path (each one
 * clickable) or a "no path" message.
 *
 * @param props - State and callbacks.
 * @returns The bar element.
 */
export function PathBar({ state, onStep, onClose }: PathBarProps): JSX.Element {
  return (
    <div className="cg-path-bar" role="status">
      {state.kind === 'picking' && (
        <span className="cg-path-bar__text">
          Path from <strong>{state.origin}</strong>: click the destination
        </span>
      )}
      {state.kind === 'none' && (
        <span className="cg-path-bar__text">
          No path between <strong>{state.from}</strong> and <strong>{state.to}</strong>
        </span>
      )}
      {state.kind === 'found' && (
        <>
          <span className="cg-path-bar__meta">
            {state.steps.length - 1} {state.steps.length === 2 ? 'step' : 'steps'}
            {state.level === 'file' ? ' · files' : ''}
            {state.reversed ? ' · goes the other way' : ''}
          </span>
          <ol className="cg-path-bar__steps">
            {state.steps.map((step, index) => (
              <li key={step.id}>
                {index > 0 && (
                  <span className="cg-path-bar__arrow" aria-hidden="true">
                    →
                  </span>
                )}
                <button
                  type="button"
                  className="cg-path-bar__step"
                  title={step.id}
                  onClick={() => {
                    onStep(step.id);
                  }}
                >
                  {step.label}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      <button
        type="button"
        className="cg-path-bar__close"
        aria-label="Close the path (Escape)"
        title="Close (Escape)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
