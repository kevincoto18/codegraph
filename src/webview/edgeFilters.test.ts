import { describe, expect, it } from 'vitest';

import { DEFAULT_EDGE_FILTERS, filterEdges } from './edgeFilters';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';

/**
 * Creates a function node inside a file.
 *
 * @param id - Function id.
 * @param fileId - Parent file id.
 * @returns The node.
 */
function fn(id: string, fileId: string): CodeGraphFlowNode {
  return {
    id,
    type: 'function',
    parentId: fileId,
    position: { x: 0, y: 0 },
    data: { label: id, filePath: fileId, line: 1, functionKind: 'function', exported: false },
  };
}

/**
 * Creates an edge.
 *
 * @param kind - Edge kind.
 * @param source - Source id.
 * @param target - Target id.
 * @returns The edge.
 */
function edge(kind: 'import' | 'call', source: string, target: string): CodeGraphFlowEdge {
  return { id: `${kind}:${source}->${target}`, source, target, data: { kind, count: 1 } };
}

const NODES = [fn('a#x', 'a'), fn('a#y', 'a'), fn('b#z', 'b')];
const IMPORT = edge('import', 'a', 'b');
const INTERNAL = edge('call', 'a#x', 'a#y');
const EXTERNAL = edge('call', 'a#x', 'b#z');
const TO_FILE = edge('call', 'a#x', 'b'); // call into a collapsed file
const EDGES = [IMPORT, INTERNAL, EXTERNAL, TO_FILE];

describe('filterEdges', () => {
  it('hides calls inside a file by default', () => {
    expect(filterEdges(EDGES, NODES, DEFAULT_EDGE_FILTERS)).toEqual([IMPORT, EXTERNAL, TO_FILE]);
  });

  it('returns the same array when everything is shown', () => {
    const all = { imports: true, calls: true, internalCalls: true };
    expect(filterEdges(EDGES, NODES, all)).toBe(EDGES);
  });

  it('filters by kind', () => {
    expect(filterEdges(EDGES, NODES, { imports: false, calls: true, internalCalls: true })).toEqual(
      [INTERNAL, EXTERNAL, TO_FILE],
    );
    expect(filterEdges(EDGES, NODES, { imports: true, calls: false, internalCalls: true })).toEqual(
      [IMPORT],
    );
  });
});
