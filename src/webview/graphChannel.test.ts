import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import { INITIAL_GRAPH_CHANNEL_STATE, reduceHostMessage, summarizeGraph } from './graphChannel';
import { functionNode, makePatch } from './testFixtures';

/** Snapshot with one file, two functions, one import and one call. */
const SNAPSHOT: GraphSnapshot = {
  version: 3,
  nodes: [
    {
      id: 'a.ts',
      kind: 'file',
      label: 'a.ts',
      filePath: 'a.ts',
      line: 1,
      functionIds: ['a.ts#x', 'a.ts#y'],
    },
    {
      id: 'a.ts#x',
      kind: 'function',
      label: 'x',
      filePath: 'a.ts',
      line: 1,
      fileId: 'a.ts',
      qualifiedName: 'x',
      functionKind: 'function',
      endLine: 1,
      exported: true,
    },
    {
      id: 'a.ts#y',
      kind: 'function',
      label: 'y',
      filePath: 'a.ts',
      line: 2,
      fileId: 'a.ts',
      qualifiedName: 'y',
      functionKind: 'arrow',
      endLine: 2,
      exported: false,
    },
  ],
  edges: [
    { id: 'import:a.ts->b.ts', kind: 'import', source: 'a.ts', target: 'b.ts' },
    { id: 'call:a.ts#x->a.ts#y', kind: 'call', source: 'a.ts#x', target: 'a.ts#y' },
  ],
};

describe('reduceHostMessage', () => {
  it('starts in the analyzing state without a graph', () => {
    expect(INITIAL_GRAPH_CHANNEL_STATE).toEqual({
      snapshot: null,
      status: 'analyzing',
      errorMessage: null,
      sessionId: 0,
      outOfSync: false,
      lastChange: null,
    });
  });

  it('stores the snapshot and becomes ready on graph/init', () => {
    const state = reduceHostMessage(INITIAL_GRAPH_CHANNEL_STATE, {
      type: 'graph/init',
      graph: SNAPSHOT,
    });
    expect(state).toEqual({
      snapshot: SNAPSHOT,
      status: 'ready',
      errorMessage: null,
      sessionId: 1,
      outOfSync: false,
      lastChange: null,
    });
  });

  it('keeps the current graph while a rescan is analyzing', () => {
    const ready = reduceHostMessage(INITIAL_GRAPH_CHANNEL_STATE, {
      type: 'graph/init',
      graph: SNAPSHOT,
    });
    const analyzing = reduceHostMessage(ready, { type: 'status', state: 'analyzing' });
    expect(analyzing).toMatchObject({
      snapshot: SNAPSHOT,
      status: 'analyzing',
      errorMessage: null,
    });
  });

  it('records error messages, with a fallback', () => {
    expect(
      reduceHostMessage(INITIAL_GRAPH_CHANNEL_STATE, {
        type: 'status',
        state: 'error',
        message: 'boom',
      }),
    ).toMatchObject({ status: 'error', errorMessage: 'boom' });
    expect(
      reduceHostMessage(INITIAL_GRAPH_CHANNEL_STATE, { type: 'status', state: 'error' }),
    ).toMatchObject({
      status: 'error',
      errorMessage: 'Unknown error',
    });
  });
});

describe('summarizeGraph', () => {
  it('counts nodes and edges by kind', () => {
    expect(summarizeGraph(SNAPSHOT)).toEqual({ files: 1, functions: 2, imports: 1, calls: 1 });
  });
});

describe('reduceHostMessage — live patches', () => {
  const ready = reduceHostMessage(INITIAL_GRAPH_CHANNEL_STATE, {
    type: 'graph/init',
    graph: SNAPSHOT,
  });

  it('ignores patches before the first snapshot', () => {
    const state = reduceHostMessage(INITIAL_GRAPH_CHANNEL_STATE, {
      type: 'graph/patch',
      patch: makePatch(1),
    });
    expect(state).toBe(INITIAL_GRAPH_CHANNEL_STATE);
  });

  it('applies the next patch and records the changed nodes', () => {
    const added = functionNode('a.ts', 'z', 9);
    const state = reduceHostMessage(ready, {
      type: 'graph/patch',
      patch: makePatch(4, { upsertNodes: [added] }),
    });
    expect(state.snapshot?.version).toBe(4);
    expect(state.snapshot?.nodes).toContainEqual(added);
    expect(state.lastChange).toEqual({ version: 4, nodeIds: new Set(['a.ts#z']) });
    expect(state.sessionId).toBe(ready.sessionId);
  });

  it('ignores stale patches', () => {
    expect(reduceHostMessage(ready, { type: 'graph/patch', patch: makePatch(3) })).toBe(ready);
  });

  it('flags a resync when patches were missed, then ignores further patches', () => {
    const gap = reduceHostMessage(ready, { type: 'graph/patch', patch: makePatch(6) });
    expect(gap).toMatchObject({ outOfSync: true, snapshot: SNAPSHOT });
    expect(reduceHostMessage(gap, { type: 'graph/patch', patch: makePatch(7) })).toBe(gap);
  });

  it('clears the resync flag and starts a new session on the next snapshot', () => {
    const gap = reduceHostMessage(ready, { type: 'graph/patch', patch: makePatch(6) });
    const resynced = reduceHostMessage(gap, {
      type: 'graph/init',
      graph: { ...SNAPSHOT, version: 6 },
    });
    expect(resynced).toMatchObject({
      outOfSync: false,
      sessionId: ready.sessionId + 1,
      lastChange: null,
    });
  });
});
