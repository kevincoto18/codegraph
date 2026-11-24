import { describe, expect, it } from 'vitest';

import {
  createMountState,
  growMountState,
  isMountComplete,
  selectMountedNodes,
  updateMountState,
} from './progressiveMount';

/**
 * Builds nodes with the given ids.
 *
 * @param ids - Node ids.
 * @returns The nodes.
 */
function nodes(...ids: string[]): { id: string }[] {
  return ids.map((id) => ({ id }));
}

/**
 * Ids of the mounted nodes.
 *
 * @param list - Mounted nodes.
 * @returns Their ids.
 */
function ids(list: readonly { readonly id: string }[]): string[] {
  return list.map((node) => node.id);
}

const OPTIONS = { threshold: 2, chunkSize: 2 };

describe('progressive mounting', () => {
  it('mounts the first canvas at once', () => {
    const state = createMountState(nodes('a', 'b', 'c'));
    expect(isMountComplete(state)).toBe(true);
    expect(ids(selectMountedNodes(state))).toEqual(['a', 'b', 'c']);
  });

  it('mounts a few new nodes at once', () => {
    const next = updateMountState(createMountState(nodes('a')), nodes('a', 'b', 'c'), OPTIONS);
    expect(isMountComplete(next)).toBe(true);
  });

  it('mounts many new nodes chunk by chunk, in canvas order', () => {
    const start = createMountState(nodes('a', 'z'));
    const source = nodes('a', 'b', 'c', 'd', 'e', 'z');
    let state = updateMountState(start, source, OPTIONS);
    expect(ids(selectMountedNodes(state))).toEqual(['a', 'b', 'c', 'z']);
    state = growMountState(state, OPTIONS);
    expect(ids(selectMountedNodes(state))).toEqual(['a', 'b', 'c', 'd', 'e', 'z']);
    expect(isMountComplete(state)).toBe(true);
    expect(selectMountedNodes(state)).toBe(source);
  });

  it('keeps mounted nodes when the canvas changes mid-way', () => {
    let state = updateMountState(
      createMountState(nodes('a')),
      nodes('a', 'b', 'c', 'd', 'e'),
      OPTIONS,
    );
    // A drag or measurement creates a new array with the same nodes.
    state = updateMountState(state, nodes('a', 'b', 'c', 'd', 'e'), OPTIONS);
    expect(ids(selectMountedNodes(state))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops removed nodes', () => {
    const state = updateMountState(createMountState(nodes('a', 'b')), nodes('b'), OPTIONS);
    expect(ids(selectMountedNodes(state))).toEqual(['b']);
    expect(state.known.has('a')).toBe(false);
  });
});
