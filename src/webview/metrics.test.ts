import { describe, expect, it } from 'vitest';

import { MetricsBuffer } from './metrics';

describe('MetricsBuffer', () => {
  it('buffers samples and drains them in order', () => {
    const buffer = new MetricsBuffer(10);
    buffer.add('layout.full', 12);
    buffer.add('render.first', 30);
    expect(buffer.size).toBe(2);
    expect(buffer.drain()).toEqual([
      { name: 'layout.full', value: 12 },
      { name: 'render.first', value: 30 },
    ]);
    expect(buffer.size).toBe(0);
    expect(buffer.drain()).toEqual([]);
  });

  it('drops the oldest samples beyond its capacity', () => {
    const buffer = new MetricsBuffer(2);
    buffer.add('a', 1);
    buffer.add('b', 2);
    buffer.add('c', 3);
    expect(buffer.drain().map((sample) => sample.name)).toEqual(['b', 'c']);
  });
});
