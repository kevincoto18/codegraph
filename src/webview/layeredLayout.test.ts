import { describe, expect, it } from 'vitest';

import type { LayeredLayoutOptions, LayeredNode, Point } from './layeredLayout';
import { assignRanks, findBackEdges, layoutLayered, reduceCrossings } from './layeredLayout';

/** Options used by most tests. */
const OPTIONS: LayeredLayoutOptions = {
  direction: 'LR',
  nodeSeparation: 10,
  rankSeparation: 50,
  sweeps: 4,
};

/**
 * Creates square nodes.
 *
 * @param ids - Node ids.
 * @returns Nodes of 100×20.
 */
function nodes(...ids: string[]): LayeredNode[] {
  return ids.map((id) => ({ id, width: 100, height: 20 }));
}

/**
 * Reads a position or fails the test.
 *
 * @param positions - Layout result.
 * @param id - Node id.
 * @returns The position.
 */
function at(positions: ReadonlyMap<string, Point>, id: string): Point {
  const point = positions.get(id);
  if (point === undefined) {
    throw new Error(`No position for ${id}`);
  }
  return point;
}

describe('findBackEdges / assignRanks', () => {
  it('ranks a chain by longest path', () => {
    const outgoing = [[1], [2], []];
    const ranks = assignRanks({ outgoing, incoming: [[], [0], [1]] }, findBackEdges(outgoing));
    expect([...ranks]).toEqual([0, 1, 2]);
  });

  it('breaks cycles so every node still gets a rank', () => {
    const outgoing = [[1], [2], [0]]; // 0 → 1 → 2 → 0
    const backEdges = findBackEdges(outgoing);
    expect(backEdges.size).toBe(1);
    const ranks = assignRanks({ outgoing, incoming: [[2], [0], [1]] }, backEdges);
    expect(new Set(ranks).size).toBe(3);
  });

  it('places a node after its longest predecessor chain', () => {
    // 0 → 1 → 2 and 0 → 2: node 2 must be at rank 2, not 1.
    const outgoing = [[1, 2], [2], []];
    const ranks = assignRanks({ outgoing, incoming: [[], [0], [0, 1]] }, findBackEdges(outgoing));
    expect(ranks[2]).toBe(2);
  });

  it('handles deep chains without recursion limits', () => {
    const size = 50_000;
    const outgoing = Array.from({ length: size }, (_, i) => (i + 1 < size ? [i + 1] : []));
    expect(findBackEdges(outgoing).size).toBe(0);
  });
});

describe('reduceCrossings', () => {
  it('untangles two crossing edges', () => {
    // Layer 0: [0, 1]; layer 1: [2, 3]; edges 0→3 and 1→2 cross until reordered.
    const layers = [
      [0, 1],
      [2, 3],
    ];
    reduceCrossings(layers, { outgoing: [[3], [2], [], []], incoming: [[], [], [1], [0]] }, 2);
    expect(layers[1]).toEqual([3, 2]);
  });
});

describe('layoutLayered', () => {
  it('flows left to right with rank separation', () => {
    const positions = layoutLayered(
      nodes('a', 'b', 'c'),
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
      OPTIONS,
    );
    expect(at(positions, 'a').x).toBe(0);
    expect(at(positions, 'b').x).toBe(150);
    expect(at(positions, 'c').x).toBe(300);
  });

  it('stacks a layer with node separation, centered on the axis', () => {
    const positions = layoutLayered(
      nodes('root', 'x', 'y'),
      [
        ['root', 'x'],
        ['root', 'y'],
      ],
      OPTIONS,
    );
    const ys = [at(positions, 'x').y, at(positions, 'y').y].sort((a, b) => a - b);
    expect(ys).toEqual([-25, 5]); // extent 20 + 10 + 20 = 50 → starts at -25
    expect(at(positions, 'root').y).toBe(-10);
  });

  it('supports top-to-bottom layouts', () => {
    const positions = layoutLayered(nodes('a', 'b'), [['a', 'b']], { ...OPTIONS, direction: 'TB' });
    expect(at(positions, 'a').y).toBe(0);
    expect(at(positions, 'b').y).toBe(70); // height 20 + 50
  });

  it('ignores self-loops, duplicate edges and unknown ids', () => {
    const positions = layoutLayered(
      nodes('a', 'b'),
      [
        ['a', 'a'],
        ['a', 'b'],
        ['a', 'b'],
        ['a', 'zzz'],
      ],
      OPTIONS,
    );
    expect(at(positions, 'b').x).toBe(150);
  });

  it('places isolated nodes in the first rank', () => {
    const positions = layoutLayered(nodes('lonely', 'a', 'b'), [['a', 'b']], OPTIONS);
    expect(at(positions, 'lonely').x).toBe(0);
  });

  it('is deterministic and scales linearly', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `n${String(i)}`);
    const edges = many
      .slice(1)
      .map((id, i) => [`n${String(Math.floor(i / 3))}`, id] as [string, string]);
    const startedAt = performance.now();
    const first = layoutLayered(nodes(...many), edges, OPTIONS);
    expect(performance.now() - startedAt).toBeLessThan(2000);
    expect(layoutLayered(nodes(...many), edges, OPTIONS)).toEqual(first);
    expect(first.size).toBe(5000);
  });
});
