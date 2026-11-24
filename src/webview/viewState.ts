/**
 * View state kept by the webview (VS Code `setState`), so reopening the
 * panel — after a window reload or switching tabs — shows the graph as it
 * was: viewport, opened and closed containers, focus and search.
 */
import type { FocusDirection } from './focus';
import { FOCUS_DEPTHS, FOCUS_DIRECTIONS } from './focus';

/** Most container ids kept in each list (larger changes are not restored). */
export const MAX_SAVED_CONTAINERS = 5000;

/** Viewport of the canvas. */
export interface SavedViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Saved focus mode. */
export interface SavedFocus {
  readonly nodeId: string;
  readonly depth: number;
  readonly direction: FocusDirection;
}

/** Everything restored when the view is mounted again. */
export interface SavedView {
  readonly viewport: SavedViewport | null;
  /** Containers opened by the user, relative to the initial collapse state. */
  readonly opened: readonly string[];
  /** Containers closed by the user, relative to the initial collapse state. */
  readonly closed: readonly string[];
  readonly focus: SavedFocus | null;
  readonly query: string;
}

/**
 * Checks whether a value is a non-null, non-array object.
 *
 * @param value - Value to inspect.
 * @returns `true` for records.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a value is a bounded list of strings.
 *
 * @param value - Value to inspect.
 * @returns `true` for a valid id list.
 */
function isIdList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SAVED_CONTAINERS &&
    value.every((item) => typeof item === 'string')
  );
}

/**
 * Validates a saved viewport.
 *
 * @param value - Raw value.
 * @returns The viewport, or `null`.
 */
function readViewport(value: unknown): SavedViewport | null {
  if (!isRecord(value)) {
    return null;
  }
  const { x, y, zoom } = value;
  return typeof x === 'number' &&
    typeof y === 'number' &&
    typeof zoom === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(zoom) &&
    zoom > 0
    ? { x, y, zoom }
    : null;
}

/**
 * Validates a saved focus.
 *
 * @param value - Raw value.
 * @returns The focus, or `null`.
 */
function readFocus(value: unknown): SavedFocus | null {
  if (!isRecord(value)) {
    return null;
  }
  const { nodeId, depth, direction } = value;
  return typeof nodeId === 'string' &&
    nodeId !== '' &&
    typeof depth === 'number' &&
    FOCUS_DEPTHS.includes(depth) &&
    FOCUS_DIRECTIONS.includes(direction as FocusDirection)
    ? { nodeId, depth, direction: direction as FocusDirection }
    : null;
}

/**
 * Reads a state saved by a previous version of the view, ignoring anything
 * malformed.
 *
 * @param value - Value returned by `getState()`.
 * @returns The saved view, or `null` when there is none.
 */
export function readSavedView(value: unknown): SavedView | null {
  if (!isRecord(value) || !isRecord(value.view)) {
    return null;
  }
  const { view } = value;
  return {
    viewport: readViewport(view.viewport),
    opened: isIdList(view.opened) ? view.opened : [],
    closed: isIdList(view.closed) ? view.closed : [],
    focus: readFocus(view.focus),
    query: typeof view.query === 'string' ? view.query : '',
  };
}

/**
 * Describes the collapsed containers as changes from the initial state.
 *
 * @param initial - Containers collapsed when the graph opens.
 * @param current - Containers collapsed now.
 * @returns The opened and closed containers (empty lists when too many changed).
 */
export function describeCollapseChanges(
  initial: ReadonlySet<string>,
  current: ReadonlySet<string>,
): { readonly opened: string[]; readonly closed: string[] } {
  const opened = [...initial].filter((id) => !current.has(id));
  const closed = [...current].filter((id) => !initial.has(id));
  return opened.length > MAX_SAVED_CONTAINERS || closed.length > MAX_SAVED_CONTAINERS
    ? { opened: [], closed: [] }
    : { opened, closed };
}

/**
 * Applies saved changes to the initial collapse state.
 *
 * @param initial - Containers collapsed when the graph opens.
 * @param saved - Saved view (or `null`).
 * @param existing - Every container of the graph (saved ids of removed files are ignored).
 * @returns The containers to collapse.
 */
export function restoreCollapsed(
  initial: Set<string>,
  saved: SavedView | null,
  existing: ReadonlySet<string>,
): Set<string> {
  if (saved === null || (saved.opened.length === 0 && saved.closed.length === 0)) {
    return initial;
  }
  const collapsed = new Set(initial);
  saved.opened.forEach((id) => collapsed.delete(id));
  saved.closed.forEach((id) => {
    if (existing.has(id)) {
      collapsed.add(id);
    }
  });
  return collapsed;
}
