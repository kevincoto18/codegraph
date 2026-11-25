import { describe, expect, it } from 'vitest';

import type { FileGraphNode, GraphEdge, GraphSnapshot } from '../shared';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import {
  DEFAULT_LAYOUT_OPTIONS,
  buildFlowGraph,
  chunkByHeight,
  layoutFileNodes,
  projectEdgesToFiles,
  stackedHeight,
  wrapTallColumns,
} from './layout';
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
      layout: { ...DEFAULT_LAYOUT_OPTIONS, rankDirection: 'TB' },
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

describe('chunkByHeight', () => {
  it('groups items without exceeding the maximum stacked height', () => {
    // 100 + 10 + 100 + 10 + 100 = 320 fits in 350; a fourth item would not.
    expect(chunkByHeight([100, 100, 100, 100, 100, 100, 100], 350, 10)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6],
    ]);
  });

  it('keeps an oversized item alone and handles empty input', () => {
    expect(chunkByHeight([500, 50], 100, 10)).toEqual([[0], [1]]);
    expect(chunkByHeight([], 100, 10)).toEqual([]);
  });
});

describe('wrapTallColumns', () => {
  /**
   * Creates a positioned file node.
   *
   * @param id - Node id.
   * @param x - Left position.
   * @param y - Top position.
   * @returns The node.
   */
  function placed(id: string, x: number, y: number): CodeGraphFlowNode {
    return {
      id,
      type: 'file',
      position: { x, y },
      width: 100,
      height: 100,
      data: { label: id, filePath: id, line: 1, functionCount: 0, collapsed: true, tooltip: id },
    };
  }

  const tallColumn = Array.from({ length: 7 }, (_, i) => placed(`r${String(i)}`, 0, i * 110));
  const nextColumn = placed('next', 200, 0);
  const wrapped = wrapTallColumns([...tallColumn, nextColumn], 350, 10);

  it('splits a tall column into side-by-side sub-columns', () => {
    // Original column spans y 0..760 (center 380); the wrapped block is
    // 3 × 100 + 2 × 10 = 320 tall, so it starts at 380 - 160 = 220.
    expect(wrapped.slice(0, 7).map((node) => node.position)).toEqual([
      { x: 0, y: 220 },
      { x: 0, y: 330 },
      { x: 0, y: 440 },
      { x: 160, y: 220 },
      { x: 160, y: 330 },
      { x: 160, y: 440 },
      { x: 320, y: 220 },
    ]);
  });

  it('shifts the following columns to make room', () => {
    expect(byId(wrapped, 'next').position).toEqual({ x: 200 + 2 * 160, y: 0 });
  });

  it('computes stacked heights', () => {
    expect(stackedHeight([], 10)).toBe(0);
    expect(stackedHeight([100, 50], 10)).toBe(160);
  });

  it('leaves short columns untouched', () => {
    const short = [placed('a', 0, 0), placed('b', 0, 110)];
    expect(wrapTallColumns(short, 1000, 10)).toEqual(short);
  });

  it('wraps a large fan-in graph into a wide grid', () => {
    const hub = file('utils.ts');
    const rules = Array.from({ length: 120 }, (_, i) => file(`rules/r${String(i)}.ts`));
    const snapshot: GraphSnapshot = {
      version: 1,
      nodes: [...rules, hub],
      edges: rules.map((rule) => imports(rule.id, hub.id)),
    };
    const nodes = buildFlowGraph(snapshot).nodes;
    const ys = nodes.map((node) => node.position.y + (node.height ?? 0));
    const xs = new Set(nodes.map((node) => Math.round(node.position.x)));
    expect(Math.max(...ys) - Math.min(...nodes.map((node) => node.position.y))).toBeLessThanOrEqual(
      DEFAULT_LAYOUT_OPTIONS.maxColumnHeight,
    );
    expect(xs.size).toBeGreaterThan(2);
    for (const a of nodes) {
      for (const b of nodes) {
        if (a !== b) {
          expect(overlaps(a, b)).toBe(false);
        }
      }
    }
  });
});
