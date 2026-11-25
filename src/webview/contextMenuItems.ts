import type { FocusDirection } from './focus';

/** What was right-clicked on the canvas. */
export type ContextMenuTarget =
  | { readonly kind: 'node'; readonly nodeId: string; readonly nodeType: 'file' | 'function' }
  | { readonly kind: 'folder'; readonly nodeId: string }
  | { readonly kind: 'pane' };

/** An action offered by the canvas context menu. */
export type ContextMenuAction =
  | { readonly type: 'focus'; readonly nodeId: string; readonly direction: FocusDirection }
  | { readonly type: 'navigate'; readonly nodeId: string }
  | { readonly type: 'toggleFolder'; readonly nodeId: string }
  | { readonly type: 'exitFocus' }
  /** Starts a path: the next clicked node is its destination. */
  | { readonly type: 'pathFrom'; readonly nodeId: string }
  /** Shows the path from the picked start to this node. */
  | { readonly type: 'pathTo'; readonly nodeId: string }
  | { readonly type: 'clearPath' };

/** Path mode, as far as the menu is concerned. */
export interface PathMenuState {
  /** Start picked with "Find path from here", waiting for a destination. */
  readonly origin: string | null;
  /** Whether a path (or a "no path" result) is shown. */
  readonly shown: boolean;
}

/** No path mode. */
const NO_PATH: PathMenuState = { origin: null, shown: false };

/** One entry of the canvas context menu. */
export interface ContextMenuItem {
  /** Stable key, unique within the menu. */
  readonly key: string;
  /** Text shown to the user. */
  readonly label: string;
  /** What happens when the entry is chosen. */
  readonly action: ContextMenuAction;
  /** Whether a separator is drawn above the entry. */
  readonly separatorBefore?: boolean;
}

/** Open context menu: where it is drawn and what it offers. */
export interface ContextMenuState {
  /** Horizontal position in viewport pixels. */
  readonly x: number;
  /** Vertical position in viewport pixels. */
  readonly y: number;
  /** Entries, in display order (never empty). */
  readonly items: readonly ContextMenuItem[];
}

/**
 * Builds the entries of the canvas context menu.
 *
 * Files and functions can be focused in each direction or opened in the
 * editor or used as the ends of a path, folders can be opened or closed, and
 * "Exit focus" / "Clear path" are added while those modes are active.
 *
 * @param target - What was right-clicked.
 * @param focusActive - Whether focus mode is currently on.
 * @param path - Path mode state.
 * @returns The menu entries; empty when there is nothing to offer.
 */
export function getContextMenuItems(
  target: ContextMenuTarget,
  focusActive: boolean,
  path: PathMenuState = NO_PATH,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (target.kind === 'node') {
    const { nodeId } = target;
    items.push(
      { key: 'focus', label: 'Focus here', action: { type: 'focus', nodeId, direction: 'both' } },
      {
        key: 'incoming',
        label: 'Show what uses it',
        action: { type: 'focus', nodeId, direction: 'incoming' },
      },
      {
        key: 'outgoing',
        label: 'Show what it uses',
        action: { type: 'focus', nodeId, direction: 'outgoing' },
      },
      ...(path.origin !== null && path.origin !== nodeId
        ? [
            {
              key: 'pathTo',
              label: 'Path to here',
              action: { type: 'pathTo', nodeId } as const,
              separatorBefore: true,
            },
          ]
        : []),
      {
        key: 'pathFrom',
        label: 'Find path from here…',
        action: { type: 'pathFrom', nodeId },
        separatorBefore: path.origin === null || path.origin === nodeId,
      },
      {
        key: 'navigate',
        label: 'Go to code',
        action: { type: 'navigate', nodeId },
        separatorBefore: true,
      },
    );
  } else if (target.kind === 'folder') {
    items.push({
      key: 'toggle',
      label: 'Open / close folder',
      action: { type: 'toggleFolder', nodeId: target.nodeId },
    });
  }
  if (path.origin !== null || path.shown) {
    items.push({
      key: 'clearPath',
      label: 'Clear path',
      action: { type: 'clearPath' },
      separatorBefore: items.length > 0,
    });
  }
  if (focusActive) {
    items.push({
      key: 'exit',
      label: 'Exit focus',
      action: { type: 'exitFocus' },
      separatorBefore: items.length > 0,
    });
  }
  return items;
}
