import { describe, expect, it } from 'vitest';

import type { Baseline, TargetResult } from './bench';
import { findRegressions } from './bench';

/**
 * Creates a target result with a given total.
 *
 * @param name - Target name.
 * @param total - Median total in ms.
 * @returns The result.
 */
function result(name: string, total: number): TargetResult {
  return { name, files: 1, nodes: 1, edges: 0, medianMs: { total } };
}

describe('findRegressions', () => {
  const baseline: Baseline = {
    createdAt: '2026-01-01T00:00:00.000Z',
    node: 'v22',
    platform: 'test',
    results: [result('big', 1000), result('tiny', 10)],
  };

  it('accepts results within the tolerance', () => {
    expect(findRegressions([result('big', 1200), result('tiny', 30)], baseline)).toEqual([]);
  });

  it('reports targets slower than tolerance plus slack', () => {
    expect(findRegressions([result('big', 1300)], baseline)).toEqual([
      'big: 1.30 s vs baseline 1.00 s',
    ]);
  });

  it('ignores targets missing from the baseline', () => {
    expect(findRegressions([result('new', 99999)], baseline)).toEqual([]);
  });
});
