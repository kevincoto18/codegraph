import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowNode } from './flowTypes';
import { DEFAULT_LAYOUT_OPTIONS, preserveFilePositions } from './layout';
import { fileNode, functionNode } from './testFixtures';
import { toFlowElements } from './toFlowElements';
import type { FolderTree } from './folders';
import { buildFolderTree } from './folders';
import type { ViewLayoutInputs } from './viewLayout';
import { computeViewLayout, isViewLayoutCurrent } from './viewLayout';

/** Two connected files. */
const BASE: GraphSnapshot = {
  version: 1,
  nodes: [fileNode('a.ts', ['a.ts#run']), functionNode('a.ts', 'run'), fileNode('b.ts')],
  edges: [{ id: 'import:a.ts->b.ts', kind: 'import', source: 'a.ts', target: 'b.ts' }],
};

/**
 * Builds layout inputs.
 *
 * @param snapshot - Graph snapshot.
 * @param collapsedIds - Collapsed files and folders.
 * @param layoutRequest - Re-layout counter.
 * @param folderTree - Folder hierarchy, if any.
 * @returns The inputs.
 */
function at(
  snapshot: GraphSnapshot,
  collapsedIds: ReadonlySet<string>,
  layoutRequest: number,
  folderTree: FolderTree | null = null,
): ViewLayoutInputs {
  return { snapshot, collapsedIds, folderTree, layoutRequest };
}

/**
 * Returns the position of a node by id or fails the test.
 *
 * @param nodes - Nodes to search.
 * @param id - Node id.
 * @returns The node position.
 */
function positionOf(nodes: readonly CodeGraphFlowNode[], id: string): { x: number; y: number } {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`Node ${id} not found`);
  }
  return node.position;
}

describe('preserveFilePositions', () => {
  const initial = computeViewLayout(null, at(BASE, new Set(), 0)).nodes;
  // Simulate the user dragging b.ts somewhere else.
  const dragged = initial.map((node) =>
    node.id === 'b.ts' ? { ...node, position: { x: 999, y: 777 } } : node,
  );

  it('keeps existing files (including manual drags) and adds new files in a right column', () => {
    const next: GraphSnapshot = {
      ...BASE,
      version: 2,
      nodes: [...BASE.nodes, fileNode('c.ts'), fileNode('d.ts')],
    };
    const nodes = preserveFilePositions(toFlowElements(next), dragged);

    expect(positionOf(nodes, 'a.ts')).toEqual(positionOf(initial, 'a.ts'));
    expect(positionOf(nodes, 'b.ts')).toEqual({ x: 999, y: 777 });

    const rightEdge = Math.max(
      ...dragged.filter((n) => n.type === 'file').map((n) => n.position.x + (n.width ?? 0)),
    );
    const top = Math.min(...dragged.filter((n) => n.type === 'file').map((n) => n.position.y));
    expect(positionOf(nodes, 'c.ts')).toEqual({
      x: rightEdge + DEFAULT_LAYOUT_OPTIONS.rankSeparation,
      y: top,
    });
    expect(positionOf(nodes, 'd.ts').x).toBe(positionOf(nodes, 'c.ts').x);
    expect(positionOf(nodes, 'd.ts').y).toBeGreaterThan(positionOf(nodes, 'c.ts').y);
  });

  it('keeps function positions relative to their file', () => {
    const nodes = preserveFilePositions(toFlowElements(BASE), dragged);
    expect(positionOf(nodes, 'a.ts#run')).toEqual(positionOf(initial, 'a.ts#run'));
  });

  it('falls back to a full layout when no previous file survives', () => {
    const replaced: GraphSnapshot = {
      version: 2,
      nodes: [fileNode('x.ts'), fileNode('y.ts')],
      edges: [],
    };
    const nodes = preserveFilePositions(toFlowElements(replaced), dragged);
    expect(nodes.every((node) => Number.isFinite(node.position.x))).toBe(true);
  });
});

describe('computeViewLayout', () => {
  const collapsed = new Set<string>();
  const first = computeViewLayout(null, at(BASE, collapsed, 0));

  it('reports how the layout was computed', () => {
    expect(first.mode).toBe('full');
    expect(computeViewLayout(first, at({ ...BASE, version: 2 }, collapsed, 0)).mode).toBe(
      'incremental',
    );
    expect(computeViewLayout(first, at(BASE, collapsed, 1)).mode).toBe('full');
  });

  it('reports whether a state matches its inputs', () => {
    expect(isViewLayoutCurrent(first, at(BASE, collapsed, 0))).toBe(true);
    expect(isViewLayoutCurrent(first, at({ ...BASE }, collapsed, 0))).toBe(false);
    expect(isViewLayoutCurrent(first, at(BASE, new Set(), 0))).toBe(false);
    expect(isViewLayoutCurrent(first, at(BASE, collapsed, 1))).toBe(false);
  });

  it('preserves positions on a snapshot-only change (live patch)', () => {
    const moved = {
      ...first,
      nodes: first.nodes.map((n) => (n.id === 'a.ts' ? { ...n, position: { x: -50, y: -50 } } : n)),
    };
    const next = computeViewLayout(moved, at({ ...BASE, version: 2 }, collapsed, 0));
    expect(positionOf(next.nodes, 'a.ts')).toEqual({ x: -50, y: -50 });
  });

  it('recomputes the full layout on re-layout or collapse changes', () => {
    const moved = {
      ...first,
      nodes: first.nodes.map((n) => (n.id === 'a.ts' ? { ...n, position: { x: -50, y: -50 } } : n)),
    };
    const relaid = computeViewLayout(moved, at(BASE, collapsed, 1));
    expect(positionOf(relaid.nodes, 'a.ts')).toEqual(positionOf(first.nodes, 'a.ts'));

    const collapsedLayout = computeViewLayout(moved, at(BASE, new Set(['a.ts']), 0));
    expect(collapsedLayout.nodes.map((node) => node.id)).toEqual(['a.ts', 'b.ts']);
  });
});

/** Files spread over nested folders: `src/app` imports `src/lib/db`. */
const NESTED: GraphSnapshot = {
  version: 1,
  nodes: [
    fileNode('src/app.ts', ['src/app.ts#main']),
    functionNode('src/app.ts', 'main'),
    fileNode('src/lib/db.ts', ['src/lib/db.ts#query']),
    functionNode('src/lib/db.ts', 'query'),
    fileNode('src/lib/cache.ts'),
    fileNode('README.ts'),
  ],
  edges: [
    {
      id: 'import:src/app.ts->src/lib/db.ts',
      kind: 'import',
      source: 'src/app.ts',
      target: 'src/lib/db.ts',
    },
    {
      id: 'call:src/app.ts#main->src/lib/db.ts#query',
      kind: 'call',
      source: 'src/app.ts#main',
      target: 'src/lib/db.ts#query',
    },
  ],
};

/**
 * Finds a node by id or fails the test.
 *
 * @param nodes - Nodes to search.
 * @param id - Node id.
 * @returns The node.
 */
function nodeOf(nodes: readonly CodeGraphFlowNode[], id: string): CodeGraphFlowNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`Node ${id} not found`);
  }
  return node;
}

describe('computeViewLayout — folders', () => {
  const tree = buildFolderTree(NESTED.nodes);

  it('sizes expanded folders around their content, below the header', () => {
    const { nodes } = computeViewLayout(null, at(NESTED, new Set(), 0, tree));
    const src = nodeOf(nodes, 'folder:src');
    const lib = nodeOf(nodes, 'folder:src/lib');
    expect(lib.parentId).toBe('folder:src');
    for (const child of nodes.filter((node) => node.parentId === 'folder:src/lib')) {
      expect(child.position.x).toBeGreaterThanOrEqual(0);
      expect(child.position.y).toBeGreaterThanOrEqual(40);
      expect(child.position.x + (child.width ?? 0)).toBeLessThanOrEqual(lib.width ?? 0);
      expect(child.position.y + (child.height ?? 0)).toBeLessThanOrEqual(lib.height ?? 0);
    }
    expect(lib.position.x + (lib.width ?? 0)).toBeLessThanOrEqual(src.width ?? 0);
    // src/app.ts depends on src/lib, so it is placed to its left inside src.
    expect(nodeOf(nodes, 'src/app.ts').position.x).toBeLessThan(lib.position.x);
  });

  it('aggregates the edges of collapsed folders', () => {
    const { nodes, edges } = computeViewLayout(
      null,
      at(NESTED, new Set(['folder:src/lib']), 0, tree),
    );
    expect(nodes.some((node) => node.id === 'src/lib/db.ts')).toBe(false);
    expect(edges.map((edge) => [edge.source, edge.target, edge.label])).toEqual([
      ['src/app.ts', 'folder:src/lib', undefined],
      ['src/app.ts#main', 'folder:src/lib', undefined],
    ]);
  });

  it('keeps positions inside folders on live patches and grows the folder', () => {
    const open = new Set<string>();
    const first = computeViewLayout(null, at(NESTED, open, 0, tree));
    const next: GraphSnapshot = {
      ...NESTED,
      version: 2,
      nodes: [...NESTED.nodes, fileNode('src/lib/new.ts')],
    };
    const updated = computeViewLayout(first, at(next, open, 0, buildFolderTree(next.nodes)));
    expect(updated.mode).toBe('incremental');
    expect(nodeOf(updated.nodes, 'src/lib/db.ts').position).toEqual(
      nodeOf(first.nodes, 'src/lib/db.ts').position,
    );
    const lib = nodeOf(updated.nodes, 'folder:src/lib');
    const added = nodeOf(updated.nodes, 'src/lib/new.ts');
    expect(added.parentId).toBe('folder:src/lib');
    expect(added.position.x + (added.width ?? 0)).toBeLessThanOrEqual(lib.width ?? 0);
  });

  it('recomputes everything when the folder view is switched', () => {
    const first = computeViewLayout(null, at(NESTED, new Set(), 0, tree));
    const flat = computeViewLayout(first, at(NESTED, new Set(), 0, null));
    expect(flat.mode).toBe('full');
    expect(flat.nodes.some((node) => node.type === 'folder')).toBe(false);
  });
});
