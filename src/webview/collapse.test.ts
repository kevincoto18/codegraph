import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode, GraphSnapshot } from '../shared';
import { getAllFileIds, getInitialCollapsedFileIds, routeEdges, toggleId } from './collapse';

/**
 * Builds a snapshot with `fileCount` files of `functionsPerFile` functions each.
 *
 * @param fileCount - Number of files.
 * @param functionsPerFile - Functions per file.
 * @returns The snapshot.
 */
function makeSnapshot(fileCount: number, functionsPerFile: number): GraphSnapshot {
  const nodes: GraphNode[] = [];
  for (let f = 0; f < fileCount; f += 1) {
    const fileId = `f${String(f)}.ts`;
    const functionIds = Array.from(
      { length: functionsPerFile },
      (_, i) => `${fileId}#fn${String(i)}`,
    );
    nodes.push({ id: fileId, kind: 'file', label: fileId, filePath: fileId, line: 1, functionIds });
    for (const id of functionIds) {
      nodes.push({
        id,
        kind: 'function',
        label: id,
        filePath: fileId,
        line: 1,
        fileId,
        qualifiedName: id,
        functionKind: 'function',
        endLine: 1,
        exported: false,
      });
    }
  }
  return { version: 1, nodes, edges: [] };
}

/**
 * Creates a call edge.
 *
 * @param source - Caller id.
 * @param target - Callee id.
 * @returns The edge.
 */
function call(source: string, target: string): GraphEdge {
  return { id: `call:${source}->${target}`, kind: 'call', source, target };
}

describe('getInitialCollapsedFileIds', () => {
  it('collapses nothing for small graphs', () => {
    expect(getInitialCollapsedFileIds(makeSnapshot(2, 3), 6)).toEqual(new Set());
  });

  it('collapses every file above the threshold', () => {
    expect(getInitialCollapsedFileIds(makeSnapshot(2, 4), 6)).toEqual(new Set(['f0.ts', 'f1.ts']));
  });
});

describe('toggleId / getAllFileIds', () => {
  it('adds missing ids and removes present ones without mutating', () => {
    const original = new Set(['a']);
    expect(toggleId(original, 'b')).toEqual(new Set(['a', 'b']));
    expect(toggleId(original, 'a')).toEqual(new Set());
    expect(original).toEqual(new Set(['a']));
  });

  it('lists every file id', () => {
    expect(getAllFileIds(makeSnapshot(3, 1))).toEqual(new Set(['f0.ts', 'f1.ts', 'f2.ts']));
  });
});

describe('routeEdges', () => {
  /** a.ts is collapsed: its functions are represented by the file node. */
  const visible = new Map([
    ['a.ts', 'a.ts'],
    ['a.ts#x', 'a.ts'],
    ['a.ts#y', 'a.ts'],
    ['b.ts', 'b.ts'],
    ['b.ts#z', 'b.ts#z'],
  ]);
  /**
   * Resolves the visible node of a model node.
   *
   * @param id - Model node id.
   * @returns The visible node id.
   */
  const resolve = (id: string): string | undefined => visible.get(id);

  it('re-routes and merges edges of collapsed files with a count', () => {
    const routed = routeEdges([call('a.ts#x', 'b.ts#z'), call('a.ts#y', 'b.ts#z')], resolve);
    expect(routed).toEqual([
      { id: 'call:a.ts->b.ts#z', kind: 'call', source: 'a.ts', target: 'b.ts#z', count: 2 },
    ]);
  });

  it('drops edges that collapse into a single node and edges to unknown nodes', () => {
    expect(routeEdges([call('a.ts#x', 'a.ts#y'), call('a.ts#x', 'zzz')], resolve)).toEqual([]);
  });

  it('keeps edges of different kinds separate', () => {
    const importEdge: GraphEdge = {
      id: 'import:a.ts->b.ts',
      kind: 'import',
      source: 'a.ts',
      target: 'b.ts',
    };
    const routed = routeEdges([importEdge, call('a.ts#x', 'b.ts#z')], (id) =>
      id === 'b.ts#z' ? 'b.ts' : resolve(id),
    );
    expect(routed.map((edge) => edge.id)).toEqual(['import:a.ts->b.ts', 'call:a.ts->b.ts']);
  });
});
