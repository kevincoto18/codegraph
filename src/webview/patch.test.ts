import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import { addClassToNodes, applyPatch, classifyPatch, getChangedNodeIds, mergeById } from './patch';
import { callEdge, fileNode, functionNode, makePatch } from './testFixtures';

/** `a.ts` with `run` (line 1) calling `stop` (line 5). */
const SNAPSHOT: GraphSnapshot = {
  version: 4,
  nodes: [
    fileNode('a.ts', ['a.ts#run', 'a.ts#stop']),
    functionNode('a.ts', 'run', 1),
    functionNode('a.ts', 'stop', 5),
  ],
  edges: [callEdge('a.ts#run', 'a.ts#stop')],
};

describe('classifyPatch', () => {
  it.each([
    [5, 'next'],
    [4, 'stale'],
    [3, 'stale'],
    [7, 'gap'],
  ] as const)('version %i is %s for a snapshot at version 4', (version, expected) => {
    expect(classifyPatch(SNAPSHOT, makePatch(version))).toBe(expected);
  });
});

describe('mergeById', () => {
  it('replaces in place, removes and appends new items', () => {
    const items = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 1 },
    ];
    expect(
      mergeById(
        items,
        [
          { id: 'b', v: 2 },
          { id: 'd', v: 1 },
        ],
        ['c'],
      ),
    ).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'd', v: 1 },
    ]);
  });
});

describe('applyPatch', () => {
  it('produces the next snapshot', () => {
    const patch = makePatch(5, {
      upsertNodes: [fileNode('a.ts', ['a.ts#run']), fileNode('b.ts')],
      removeNodeIds: ['a.ts#stop'],
      removeEdgeIds: ['call:a.ts#run->a.ts#stop'],
    });
    expect(applyPatch(SNAPSHOT, patch)).toEqual({
      version: 5,
      nodes: [fileNode('a.ts', ['a.ts#run']), functionNode('a.ts', 'run', 1), fileNode('b.ts')],
      edges: [],
    });
  });

  it('does not mutate the original snapshot', () => {
    const copy = structuredClone(SNAPSHOT);
    applyPatch(SNAPSHOT, makePatch(5, { removeNodeIds: ['a.ts#run'] }));
    expect(SNAPSHOT).toEqual(copy);
  });
});

describe('getChangedNodeIds', () => {
  it('reports new nodes and meaningful changes but not pure line shifts', () => {
    const patch = makePatch(5, {
      upsertNodes: [
        functionNode('a.ts', 'run', 3, { endLine: 3 }), // moved only
        functionNode('a.ts', 'stop', 5, { exported: true }), // export changed
        functionNode('a.ts', 'init', 9), // new
      ],
    });
    expect(getChangedNodeIds(SNAPSHOT, patch)).toEqual(new Set(['a.ts#stop', 'a.ts#init']));
  });
});

describe('addClassToNodes', () => {
  it('appends a class to selected nodes only', () => {
    const nodes = [{ id: 'a', className: 'cg-match' }, { id: 'b' }];
    expect(addClassToNodes(nodes, new Set(), 'x')).toBe(nodes);
    expect(addClassToNodes(nodes, new Set(['a', 'b']), 'cg-changed')).toEqual([
      { id: 'a', className: 'cg-match cg-changed' },
      { id: 'b', className: 'cg-changed' },
    ]);
  });
});
