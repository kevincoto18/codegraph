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
  | { readonly type: 'exitFocus' };

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
 * editor, folders can be opened or closed, and "Exit focus" is added
 * whenever focus mode is active.
 *
 * @param target - What was right-clicked.
 * @param focusActive - Whether focus mode is currently on.
 * @returns The menu entries; empty when there is nothing to offer.
 */
export function getContextMenuItems(
  target: ContextMenuTarget,
  focusActive: boolean,
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
