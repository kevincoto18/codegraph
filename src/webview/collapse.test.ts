import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode, GraphSnapshot } from '../shared';
import {
  collapseNewContainers,
  getAllContainerIds,
  getAllFileIds,
  getIdsToReveal,
  getInitialCollapsedFileIds,
  getInitialCollapsedIds,
  getNextLevelToExpand,
  planExpandAll,
  routeEdges,
  toggleId,
} from './collapse';
import type { CodeGraphFlowNode } from './flowTypes';
import { buildFolderTree } from './folders';
import { fileNode, functionNode } from './testFixtures';

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
  it('collapses every file in "always" mode, even small graphs', () => {
    expect(getInitialCollapsedFileIds(makeSnapshot(2, 1), 'always')).toEqual(
      new Set(['f0.ts', 'f1.ts']),
    );
  });

  it('collapses nothing in "never" mode, even large graphs', () => {
    expect(getInitialCollapsedFileIds(makeSnapshot(2, 4), 'never', 6)).toEqual(new Set());
  });

  it('collapses only above the threshold in "auto" mode', () => {
    expect(getInitialCollapsedFileIds(makeSnapshot(2, 3), 'auto', 6)).toEqual(new Set());
    expect(getInitialCollapsedFileIds(makeSnapshot(2, 4), 'auto', 6)).toEqual(
      new Set(['f0.ts', 'f1.ts']),
    );
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

/** Nested files used by the folder helpers. */
const NESTED: GraphSnapshot = {
  version: 1,
  nodes: [
    fileNode('src/app.ts', ['src/app.ts#main']),
    functionNode('src/app.ts', 'main'),
    fileNode('src/lib/db.ts', ['src/lib/db.ts#query']),
    functionNode('src/lib/db.ts', 'query'),
    fileNode('top.ts'),
  ],
  edges: [],
};

describe('folder collapse helpers', () => {
  const tree = buildFolderTree(NESTED.nodes);

  it('starts with every folder collapsed plus the files of the collapse mode', () => {
    expect(getInitialCollapsedIds(NESTED, 'never', tree)).toEqual(
      new Set(['folder:src', 'folder:src/lib']),
    );
    expect(getInitialCollapsedIds(NESTED, 'always', null)).toEqual(getAllFileIds(NESTED));
    expect(getAllContainerIds(NESTED, tree).size).toBe(5);
  });

  it('reveals the file of a function and every folder above it', () => {
    expect(getIdsToReveal(NESTED, tree, ['src/lib/db.ts#query'])).toEqual(
      new Set(['src/lib/db.ts', 'folder:src/lib', 'folder:src']),
    );
    expect(getIdsToReveal(NESTED, tree, ['src/app.ts'])).toEqual(new Set(['folder:src']));
    expect(getIdsToReveal(NESTED, null, ['src/app.ts#main'])).toEqual(new Set(['src/app.ts']));
  });

  it('opens folders first, then files', () => {
    const folder = {
      id: 'folder:src',
      type: 'folder',
      position: { x: 0, y: 0 },
      data: { label: 'src', path: 'src', fileCount: 2, collapsed: true },
    } as const satisfies CodeGraphFlowNode;
    /**
     * Creates a collapsed file node.
     *
     * @param id - File id.
     * @param functionCount - Number of functions.
     * @returns The node.
     */
    const file = (id: string, functionCount: number): CodeGraphFlowNode => ({
      id,
      type: 'file',
      position: { x: 0, y: 0 },
      data: { label: id, filePath: id, line: 1, functionCount, collapsed: true },
    });
    expect(getNextLevelToExpand([folder, file('top.ts', 1)])).toEqual(['folder:src']);
    expect(getNextLevelToExpand([file('a.ts', 2), file('empty.ts', 0)])).toEqual(['a.ts']);
    expect(getNextLevelToExpand([])).toEqual([]);
  });
});

describe('planExpandAll', () => {
  const tree = buildFolderTree(NESTED.nodes);
  const allCollapsed = getAllContainerIds(NESTED, tree);

  it('opens everything when it fits', () => {
    const plan = planExpandAll(NESTED, tree, allCollapsed, 100);
    expect(plan).toEqual({ collapsedIds: new Set(), complete: true });
  });

  it('opens folders before files and stops at the budget', () => {
    // Visible: src + top.ts (2). Opening src adds app.ts + lib (4), lib adds db.ts (5).
    const plan = planExpandAll(NESTED, tree, allCollapsed, 5);
    expect(plan.complete).toBe(false);
    expect(plan.collapsedIds).toEqual(new Set(['src/app.ts', 'src/lib/db.ts']));
  });

  it('works without folder view', () => {
    const plan = planExpandAll(NESTED, null, getAllFileIds(NESTED), 4);
    // 3 files visible; opening app.ts adds 1 function (4), db.ts would exceed.
    expect(plan).toEqual({ collapsedIds: new Set(['src/lib/db.ts']), complete: false });
  });
});

describe('collapseNewContainers', () => {
  it('collapses only the containers that just appeared', () => {
    const collapsed = new Set(['a.ts']);
    const next = collapseNewContainers(
      collapsed,
      new Set(['a.ts', 'b.ts', 'c.ts']),
      new Set(['a.ts', 'b.ts']),
    );
    expect([...next].sort()).toEqual(['a.ts', 'c.ts']);
  });

  it('keeps the same set when nothing is new', () => {
    const collapsed = new Set(['a.ts']);
    expect(collapseNewContainers(collapsed, new Set(['b.ts']), new Set(['a.ts', 'b.ts']))).toBe(
      collapsed,
    );
  });
});
