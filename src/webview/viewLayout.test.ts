import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowNode } from './flowTypes';
import { DEFAULT_LAYOUT_OPTIONS, preserveFilePositions } from './layout';
import { fileNode, functionNode } from './testFixtures';
import { toFlowElements } from './toFlowElements';
import { computeViewLayout, isViewLayoutCurrent } from './viewLayout';

/** Two connected files. */
const BASE: GraphSnapshot = {
  version: 1,
  nodes: [fileNode('a.ts', ['a.ts#run']), functionNode('a.ts', 'run'), fileNode('b.ts')],
  edges: [{ id: 'import:a.ts->b.ts', kind: 'import', source: 'a.ts', target: 'b.ts' }],
};

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
  const initial = computeViewLayout(null, BASE, new Set(), 0).nodes;
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
  const first = computeViewLayout(null, BASE, collapsed, 0);

  it('reports whether a state matches its inputs', () => {
    expect(isViewLayoutCurrent(first, BASE, collapsed, 0)).toBe(true);
    expect(isViewLayoutCurrent(first, { ...BASE }, collapsed, 0)).toBe(false);
    expect(isViewLayoutCurrent(first, BASE, new Set(), 0)).toBe(false);
    expect(isViewLayoutCurrent(first, BASE, collapsed, 1)).toBe(false);
  });

  it('preserves positions on a snapshot-only change (live patch)', () => {
    const moved = {
      ...first,
      nodes: first.nodes.map((n) => (n.id === 'a.ts' ? { ...n, position: { x: -50, y: -50 } } : n)),
    };
    const next = computeViewLayout(moved, { ...BASE, version: 2 }, collapsed, 0);
    expect(positionOf(next.nodes, 'a.ts')).toEqual({ x: -50, y: -50 });
  });

  it('recomputes the full layout on re-layout or collapse changes', () => {
    const moved = {
      ...first,
      nodes: first.nodes.map((n) => (n.id === 'a.ts' ? { ...n, position: { x: -50, y: -50 } } : n)),
    };
    const relaid = computeViewLayout(moved, BASE, collapsed, 1);
    expect(positionOf(relaid.nodes, 'a.ts')).toEqual(positionOf(first.nodes, 'a.ts'));

    const collapsedLayout = computeViewLayout(moved, BASE, new Set(['a.ts']), 0);
    expect(collapsedLayout.nodes.map((node) => node.id)).toEqual(['a.ts', 'b.ts']);
  });
});
