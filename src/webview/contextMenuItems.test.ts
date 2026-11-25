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
    expect(keys(items)).toEqual(['focus', 'incoming', 'outgoing', 'pathFrom', 'navigate']);
    expect(items[1]?.action).toEqual({ type: 'focus', nodeId: 'a.ts#run', direction: 'incoming' });
    expect(items[2]?.action).toEqual({ type: 'focus', nodeId: 'a.ts#run', direction: 'outgoing' });
    expect(items[3]?.action).toEqual({ type: 'pathFrom', nodeId: 'a.ts#run' });
    expect(items[4]?.separatorBefore).toBe(true);
  });

  it('adds exit focus after the node entries when focus is active', () => {
    const items = getContextMenuItems({ kind: 'node', nodeId: 'a.ts', nodeType: 'file' }, true);
    expect(keys(items)).toEqual(['focus', 'incoming', 'outgoing', 'pathFrom', 'navigate', 'exit']);
    expect(items.at(-1)?.separatorBefore).toBe(true);
  });

  it('offers the destination of a path being picked, and clearing it', () => {
    const picking = { origin: 'a.ts#run', shown: false };
    const items = getContextMenuItems(
      { kind: 'node', nodeId: 'b.ts#save', nodeType: 'function' },
      false,
      picking,
    );
    expect(keys(items)).toEqual([
      'focus',
      'incoming',
      'outgoing',
      'pathTo',
      'pathFrom',
      'navigate',
      'clearPath',
    ]);
    expect(items[3]?.action).toEqual({ type: 'pathTo', nodeId: 'b.ts#save' });
    // The start itself cannot be its own destination.
    const onOrigin = getContextMenuItems(
      { kind: 'node', nodeId: 'a.ts#run', nodeType: 'function' },
      false,
      picking,
    );
    expect(keys(onOrigin)).not.toContain('pathTo');
    expect(
      keys(getContextMenuItems({ kind: 'pane' }, false, { origin: null, shown: true })),
    ).toEqual(['clearPath']);
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
