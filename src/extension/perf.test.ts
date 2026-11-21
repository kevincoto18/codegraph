import { describe, expect, it } from 'vitest';

import { PerformanceTracker, formatMetricValue, formatPerformanceReport } from './perf';

/**
 * Creates a fake clock that advances by fixed steps on every read.
 *
 * @param step - Milliseconds added per read.
 * @returns The clock.
 */
function steppingClock(step: number): () => number {
  let now = 0;
  return () => {
    now += step;
    return now;
  };
}

describe('PerformanceTracker', () => {
  it('aggregates samples per metric', () => {
    const tracker = new PerformanceTracker();
    tracker.record('parse', 10);
    tracker.record('parse', 30);
    tracker.record('size', 2048, 'bytes');
    expect(tracker.get('parse')).toEqual({ unit: 'ms', count: 2, total: 40, max: 30, last: 30 });
    expect(tracker.get('size')).toEqual({
      unit: 'bytes',
      count: 1,
      total: 2048,
      max: 2048,
      last: 2048,
    });
    expect(tracker.get('missing')).toBeUndefined();
  });

  it('times synchronous and asynchronous operations', async () => {
    const tracker = new PerformanceTracker(steppingClock(5));
    expect(tracker.measure('sync', () => 42)).toBe(42);
    await expect(tracker.measureAsync('async', () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(tracker.get('sync')?.last).toBe(5);
    expect(tracker.get('async')?.last).toBe(5);
  });

  it('records the duration even when the operation throws', () => {
    const tracker = new PerformanceTracker(steppingClock(3));
    expect(() =>
      tracker.measure('boom', () => {
        throw new Error('fail');
      }),
    ).toThrow('fail');
    expect(tracker.get('boom')?.count).toBe(1);
  });

  it('lists entries sorted and resets by prefix', () => {
    const tracker = new PerformanceTracker();
    tracker.record('update.link', 1);
    tracker.record('scan.parse', 1);
    tracker.record('scan.link', 1);
    expect(tracker.entries().map(([name]) => name)).toEqual([
      'scan.link',
      'scan.parse',
      'update.link',
    ]);
    tracker.reset('scan.');
    expect(tracker.entries().map(([name]) => name)).toEqual(['update.link']);
    tracker.reset();
    expect(tracker.entries()).toEqual([]);
  });
});

describe('formatMetricValue', () => {
  it.each([
    [12.345, 'ms', '12.3 ms'],
    [1534, 'ms', '1.53 s'],
    [2048, 'bytes', '2.0 KB'],
    [3 * 1024 * 1024, 'bytes', '3.0 MB'],
    [41.6, 'count', '42'],
  ] as const)('formats %d %s as %s', (value, unit, expected) => {
    expect(formatMetricValue(value, unit)).toBe(expected);
  });
});

describe('formatPerformanceReport', () => {
  it('renders a Markdown table', () => {
    const tracker = new PerformanceTracker();
    tracker.record('scan.total', 100);
    tracker.record('scan.total', 300);
    expect(formatPerformanceReport('Report', tracker)).toBe(
      [
        '# Report',
        '',
        '| Metric | Samples | Last | Average | Max | Total |',
        '| --- | ---: | ---: | ---: | ---: | ---: |',
        '| `scan.total` | 2 | 300.0 ms | 200.0 ms | 300.0 ms | 400.0 ms |',
        '',
      ].join('\n'),
    );
  });

  it('explains when nothing was recorded', () => {
    expect(formatPerformanceReport('Report', new PerformanceTracker())).toContain(
      'No metrics recorded yet',
    );
  });
});
