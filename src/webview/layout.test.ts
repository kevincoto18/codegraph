import { describe, expect, it } from 'vitest';

import type { FileGraphNode, GraphEdge, GraphSnapshot } from '../shared';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import { buildFlowGraph, layoutFileNodes, projectEdgesToFiles } from './layout';
import { toFlowElements } from './toFlowElements';

/**
 * Creates a file node without functions.
 *
 * @param id - File path used as id.
 * @returns The model node.
 */
function file(id: string): FileGraphNode {
  return { id, kind: 'file', label: id, filePath: id, line: 1, functionIds: [] };
}

/**
 * Creates an import edge.
 *
 * @param source - Importer file.
 * @param target - Imported file.
 * @returns The model edge.
 */
function imports(source: string, target: string): GraphEdge {
  return { id: `import:${source}->${target}`, kind: 'import', source, target };
}

/** Chain `app → service → db`, plus an unrelated `util`. */
const CHAIN: GraphSnapshot = {
  version: 1,
  nodes: [file('app.ts'), file('service.ts'), file('db.ts'), file('util.ts')],
  edges: [imports('app.ts', 'service.ts'), imports('service.ts', 'db.ts')],
};

/**
 * Finds a node by id or fails the test.
 *
 * @param nodes - Laid-out nodes.
 * @param id - Node id.
 * @returns The node.
 */
function byId(nodes: readonly CodeGraphFlowNode[], id: string): CodeGraphFlowNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`Node ${id} not found`);
  }
  return node;
}

/**
 * Checks whether two file containers overlap.
 *
 * @param a - First node.
 * @param b - Second node.
 * @returns `true` if their rectangles intersect.
 */
function overlaps(a: CodeGraphFlowNode, b: CodeGraphFlowNode): boolean {
  const aw = a.width ?? 0;
  const ah = a.height ?? 0;
  const bw = b.width ?? 0;
  const bh = b.height ?? 0;
  return (
    a.position.x < b.position.x + bw &&
    b.position.x < a.position.x + aw &&
    a.position.y < b.position.y + bh &&
    b.position.y < a.position.y + ah
  );
}

describe('projectEdgesToFiles', () => {
  it('maps function edges to their files, deduplicates and drops intra-file edges', () => {
    const fileOf = new Map([
      ['a', 'a'],
      ['a#x', 'a'],
      ['a#y', 'a'],
      ['b#z', 'b'],
    ]);
    /**
     * Creates a minimal canvas edge.
     *
     * @param source - Source node id.
     * @param target - Target node id.
     * @returns The edge.
     */
    const edge = (source: string, target: string): CodeGraphFlowEdge => ({
      id: `${source}-${target}`,
      source,
      target,
    });
    expect(
      projectEdgesToFiles([edge('a#x', 'b#z'), edge('a#y', 'b#z'), edge('a#x', 'a#y')], fileOf),
    ).toEqual([['a', 'b']]);
  });
});

describe('layoutFileNodes', () => {
  const nodes = buildFlowGraph(CHAIN).nodes;

  it('places dependencies left to right', () => {
    const app = byId(nodes, 'app.ts').position.x;
    const service = byId(nodes, 'service.ts').position.x;
    const db = byId(nodes, 'db.ts').position.x;
    expect(app).toBeLessThan(service);
    expect(service).toBeLessThan(db);
  });

  it('never overlaps file containers', () => {
    for (const a of nodes) {
      for (const b of nodes) {
        if (a !== b) {
          expect(overlaps(a, b)).toBe(false);
        }
      }
    }
  });

  it('supports a top-to-bottom direction', () => {
    const vertical = buildFlowGraph(CHAIN, {
      rankDirection: 'TB',
      nodeSeparation: 40,
      rankSeparation: 100,
    }).nodes;
    expect(byId(vertical, 'app.ts').position.y).toBeLessThan(
      byId(vertical, 'service.ts').position.y,
    );
  });

  it('keeps function positions relative to their file', () => {
    const snapshot: GraphSnapshot = {
      version: 1,
      nodes: [
        { ...file('a.ts'), functionIds: ['a.ts#f'] },
        {
          id: 'a.ts#f',
          kind: 'function',
          label: 'f',
          filePath: 'a.ts',
          line: 1,
          fileId: 'a.ts',
          qualifiedName: 'f',
          functionKind: 'function',
          endLine: 1,
          exported: false,
        },
      ],
      edges: [],
    };
    const elements = toFlowElements(snapshot);
    const laidOut = layoutFileNodes(elements);
    expect(byId(laidOut, 'a.ts#f').position).toEqual(byId(elements.nodes, 'a.ts#f').position);
  });

  it('is deterministic', () => {
    expect(buildFlowGraph(CHAIN)).toEqual(buildFlowGraph(CHAIN));
  });
});
