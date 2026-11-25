/**
 * Card shown when the pointer rests on a function: its signature, the first
 * paragraph of its documentation and where it is declared.
 */
import type { JSX } from 'react';

import type { FunctionDetails } from '../shared';

/** Width of the card, in pixels (also used to keep it on screen). */
const CARD_WIDTH = 420;

/** Height reserved below a node before the card flips above it. */
const CARD_SPACE = 160;

/** Props of {@link HoverCard}. */
interface HoverCardProps {
  /** Screen rectangle of the hovered node. */
  readonly anchor: { readonly left: number; readonly top: number; readonly bottom: number };
  /** Function name. */
  readonly name: string;
  /** Where it is declared, e.g. `src/a.ts · line 12 · exported`. */
  readonly location: string;
  /** Details: `undefined` while loading, `null` when unavailable. */
  readonly details: FunctionDetails | null | undefined;
}

/**
 * Hover card of a function, below its node (above when there is no room).
 *
 * @param props - Anchor, name, location and details.
 * @returns The card element.
 */
export function HoverCard({ anchor, name, location, details }: HoverCardProps): JSX.Element {
  const below = anchor.bottom + CARD_SPACE < window.innerHeight;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8));
  const style = below
    ? { left, top: anchor.bottom + 6 }
    : { left, bottom: window.innerHeight - anchor.top + 6 };
  return (
    <div className="cg-hover-card" role="tooltip" style={{ ...style, maxWidth: CARD_WIDTH }}>
      <code className="cg-hover-card__signature">
        {details === undefined || details === null ? name : details.signature}
      </code>
      {details === undefined && <p className="cg-hover-card__doc cg-hover-card__doc--muted">…</p>}
      {details?.doc !== undefined && details.doc !== null && (
        <p className="cg-hover-card__doc">{details.doc}</p>
      )}
      <p className="cg-hover-card__meta">{location}</p>
    </div>
  );
}
