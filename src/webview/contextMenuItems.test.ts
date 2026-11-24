import { describe, expect, it } from 'vitest';

import { getContextMenuItems } from './contextMenuItems';

/**
 * Keys of the entries built for a target.
 *
 * @param items - Menu entries.
 * @returns Their keys, in order.
 */
function keys(items: readonly { readonly key: string }[]): string[] {
  return items.map((item) => item.key);
}

describe('getContextMenuItems', () => {
  it('offers focus in each direction and navigation for a function', () => {
    const items = getContextMenuItems(
      { kind: 'node', nodeId: 'a.ts#run', nodeType: 'function' },
      false,
    );
    expect(keys(items)).toEqual(['focus', 'incoming', 'outgoing', 'navigate']);
    expect(items[1]?.action).toEqual({ type: 'focus', nodeId: 'a.ts#run', direction: 'incoming' });
    expect(items[2]?.action).toEqual({ type: 'focus', nodeId: 'a.ts#run', direction: 'outgoing' });
    expect(items[3]?.separatorBefore).toBe(true);
  });

  it('adds exit focus after the node entries when focus is active', () => {
    const items = getContextMenuItems({ kind: 'node', nodeId: 'a.ts', nodeType: 'file' }, true);
    expect(keys(items)).toEqual(['focus', 'incoming', 'outgoing', 'navigate', 'exit']);
    expect(items.at(-1)?.separatorBefore).toBe(true);
  });

  it('offers opening or closing a folder', () => {
    const items = getContextMenuItems({ kind: 'folder', nodeId: 'dir:src' }, false);
    expect(items).toEqual([
      {
        key: 'toggle',
        label: 'Open / close folder',
        action: { type: 'toggleFolder', nodeId: 'dir:src' },
      },
    ]);
  });

  it('offers only exit focus on the background', () => {
    expect(getContextMenuItems({ kind: 'pane' }, false)).toEqual([]);
    const items = getContextMenuItems({ kind: 'pane' }, true);
    expect(keys(items)).toEqual(['exit']);
    expect(items[0]?.separatorBefore).toBe(false);
  });
});
