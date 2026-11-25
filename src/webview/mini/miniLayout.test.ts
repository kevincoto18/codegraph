import { describe, expect, it } from 'vitest';

import type { MiniBox } from './miniLayout';
import { EMPTY_OUTGOING_ID, TRUNK_IN_ID, TRUNK_OUT_ID, layoutMiniGraph } from './miniLayout';

const INPUT = {
  incoming: ['a', 'b', 'c'],
  outgoing: ['d'],
  hasMoreIncoming: false,
  hasMoreOutgoing: false,
  centerHeight: 120,
};

/**
 * Returns an item that must exist.
 *
 * @param items - List.
 * @param index - Index.
 * @returns The item.
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`No item at ${String(index)}`);
  }
  return item;
}

/**
 * Vertical middle of a box.
 *
 * @param box - Box.
 * @returns Its middle y.
 */
function middleY(box: MiniBox): number {
  return box.y + box.height / 2;
}

/**
 * Whether two boxes overlap.
 *
 * @param a - First box.
 * @param b - Second box.
 * @returns `true` when they intersect.
 */
function overlaps(a: MiniBox, b: MiniBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('layoutMiniGraph', () => {
  it('puts users left and dependencies right in a wide view, centered', () => {
    const layout = layoutMiniGraph(INPUT, 800, 600);
    expect(layout.orientation).toBe('horizontal');
    expect(layout.incoming.every((box) => box.x + box.width < layout.center.x)).toBe(true);
    expect(layout.outgoing.every((box) => box.x > layout.center.x + layout.center.width)).toBe(
      true,
    );
    expect(middleY(layout.center)).toBeCloseTo(300, 0);
    const left = at(layout.incoming, 0).x;
    const right = at(layout.outgoing, 0).x + at(layout.outgoing, 0).width;
    expect(left).toBeCloseTo(800 - right, 0);
  });

  it('stacks users above and dependencies below in a narrow view', () => {
    const layout = layoutMiniGraph(INPUT, 300, 900);
    expect(layout.orientation).toBe('vertical');
    expect(layout.incoming.every((box) => box.y + box.height < layout.center.y)).toBe(true);
    expect(layout.outgoing.every((box) => box.y > layout.center.y + layout.center.height)).toBe(
      true,
    );
    expect(layout.center.x + layout.center.width / 2).toBeCloseTo(150, 0);
  });

  it('never overlaps boxes', () => {
    for (const width of [220, 300, 400, 599, 600, 900]) {
      const layout = layoutMiniGraph(
        { ...INPUT, incoming: ['1', '2', '3', '4', '5', '6'], hasMoreIncoming: true },
        width,
        400,
      );
      const boxes = [layout.center, ...layout.incoming, ...layout.outgoing];
      if (layout.moreIncoming !== null) {
        boxes.push(layout.moreIncoming);
      }
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          expect(
            overlaps(at(boxes, i), at(boxes, j)),
            `${String(width)}: ${at(boxes, i).id}/${at(boxes, j).id}`,
          ).toBe(false);
        }
      }
    }
  });

  it('draws a placeholder for an empty side, without edges', () => {
    const layout = layoutMiniGraph({ ...INPUT, outgoing: [] }, 800, 600);
    expect(layout.outgoing.map((box) => box.id)).toEqual([EMPTY_OUTGOING_ID]);
    expect(layout.edges.map((edge) => edge.id)).toEqual(['a', 'b', 'c']);
  });

  it('links each section with a single connector in a narrow view', () => {
    const layout = layoutMiniGraph(INPUT, 300, 900);
    expect(layout.edges.map((edge) => [edge.id, edge.trunk])).toEqual([
      [TRUNK_IN_ID, true],
      [TRUNK_OUT_ID, true],
    ]);
    expect(layoutMiniGraph({ ...INPUT, outgoing: [] }, 300, 900).edges).toHaveLength(1);
  });

  it('grows past the viewport when the content does not fit', () => {
    const layout = layoutMiniGraph({ ...INPUT, centerHeight: 500 }, 300, 200);
    expect(layout.height).toBeGreaterThan(200);
    expect(layout.incomingLabel.y).toBeGreaterThanOrEqual(16);
  });
});
