import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode, GraphSnapshot } from '../../shared';
import { diffSnapshots, isEmptyPatch, isStructurallyEqual } from './diff';

/**
 * Creates a minimal file node.
 *
 * @param id - File path used as id.
 * @param functionIds - Ids of contained functions.
 * @returns The node.
 */
function fileNode(id: string, functionIds: string[] = []): GraphNode {
  return { id, kind: 'file', label: id, filePath: id, line: 1, functionIds };
}

/**
 * Creates a minimal call edge.
 *
 * @param source - Caller id.
 * @param target - Callee id.
 * @returns The edge.
 */
function callEdge(source: string, target: string): GraphEdge {
  return { id: `call:${source}->${target}`, kind: 'call', source, target, line: 1 };
}

/**
 * Creates a snapshot.
 *
 * @param version - Snapshot version.
 * @param nodes - Nodes.
 * @param edges - Edges.
 * @returns The snapshot.
 */
function snapshot(version: number, nodes: GraphNode[], edges: GraphEdge[] = []): GraphSnapshot {
  return { version, nodes, edges };
}

describe('diffSnapshots', () => {
  it('reports added, modified and removed nodes and edges', () => {
    const previous = snapshot(
      1,
      [fileNode('a'), fileNode('b'), fileNode('c')],
      [callEdge('a', 'b')],
    );
    const next = snapshot(
      2,
      [fileNode('a'), fileNode('b', ['b#x']), fileNode('d')],
      [callEdge('a', 'd')],
    );

    expect(diffSnapshots(previous, next)).toEqual({
      version: 2,
      upsertNodes: [fileNode('b', ['b#x']), fileNode('d')],
      removeNodeIds: ['c'],
      upsertEdges: [callEdge('a', 'd')],
      removeEdgeIds: ['call:a->b'],
    });
  });

  it('produces an empty patch for identical snapshots', () => {
    const graph = snapshot(1, [fileNode('a')], [callEdge('a', 'a')]);
    const patch = diffSnapshots(graph, { ...graph, version: 2 });
    expect(isEmptyPatch(patch)).toBe(true);
    expect(patch.version).toBe(2);
  });
});

describe('isEmptyPatch', () => {
  it('detects any change', () => {
    const empty = {
      version: 1,
      upsertNodes: [],
      removeNodeIds: [],
      upsertEdges: [],
      removeEdgeIds: [],
    };
    expect(isEmptyPatch(empty)).toBe(true);
    expect(isEmptyPatch({ ...empty, removeEdgeIds: ['x'] })).toBe(false);
  });
});

describe('isStructurallyEqual', () => {
  it.each([
    [1, 1, true],
    ['a', 'b', false],
    [null, null, true],
    [null, {}, false],
    [[1, [2]], [1, [2]], true],
    [[1, 2], [1], false],
    [[1], { 0: 1 }, false],
    [{ a: 1, b: { c: [1] } }, { b: { c: [1] }, a: 1 }, true],
    [{ a: 1 }, { a: 1, b: undefined }, false],
    [{ a: undefined }, { b: undefined }, false],
  ])('compares %j and %j → %s', (a, b, expected) => {
    expect(isStructurallyEqual(a, b)).toBe(expected);
  });
});
