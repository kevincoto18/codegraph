import { describe, expect, it } from 'vitest';

import { describeCollapseChanges, readSavedView, restoreCollapsed } from './viewState';

describe('readSavedView', () => {
  it('reads a valid state', () => {
    expect(
      readSavedView({
        view: {
          viewport: { x: 10, y: -5, zoom: 0.8 },
          opened: ['folder:src'],
          closed: ['src/a.ts'],
          focus: { nodeId: 'src/a.ts#run', depth: 2, direction: 'incoming' },
          query: 'run',
        },
      }),
    ).toEqual({
      viewport: { x: 10, y: -5, zoom: 0.8 },
      opened: ['folder:src'],
      closed: ['src/a.ts'],
      focus: { nodeId: 'src/a.ts#run', depth: 2, direction: 'incoming' },
      query: 'run',
    });
  });

  it('ignores missing or malformed parts', () => {
    expect(readSavedView(undefined)).toBeNull();
    expect(
      readSavedView({
        view: { viewport: { x: 'a' }, opened: [1], focus: { nodeId: 'x', depth: 9 } },
      }),
    ).toEqual({ viewport: null, opened: [], closed: [], focus: null, query: '' });
  });
});

describe('collapse changes', () => {
  it('saves and restores what the user opened and closed', () => {
    const initial = new Set(['a', 'b', 'c']);
    const changes = describeCollapseChanges(initial, new Set(['b', 'c', 'd']));
    expect(changes).toEqual({ opened: ['a'], closed: ['d'] });
    const restored = restoreCollapsed(
      new Set(initial),
      { viewport: null, ...changes, focus: null, query: '' },
      new Set(['a', 'b', 'c', 'd']),
    );
    expect([...restored].sort()).toEqual(['b', 'c', 'd']);
  });

  it('ignores closed containers that no longer exist', () => {
    const restored = restoreCollapsed(
      new Set(['a']),
      { viewport: null, opened: [], closed: ['gone'], focus: null, query: '' },
      new Set(['a']),
    );
    expect([...restored]).toEqual(['a']);
  });
});
