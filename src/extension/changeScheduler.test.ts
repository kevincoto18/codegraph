import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileChangeKind } from './changeScheduler';
import { ChangeScheduler, DEFAULT_CHANGE_DELAY_MS } from './changeScheduler';

describe('ChangeScheduler', () => {
  let calls: [string, FileChangeKind][];
  let scheduler: ChangeScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    scheduler = new ChangeScheduler((filePath, kind) => {
      calls.push([filePath, kind]);
    });
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  it('runs the handler once the delay elapses', () => {
    scheduler.schedule('a.ts', 'update');
    vi.advanceTimersByTime(DEFAULT_CHANGE_DELAY_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['a.ts', 'update']]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('coalesces bursts for the same file and restarts the delay', () => {
    scheduler.schedule('a.ts', 'update');
    vi.advanceTimersByTime(200);
    scheduler.schedule('a.ts', 'update');
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([['a.ts', 'update']]);
  });

  it('keeps the last kind of change', () => {
    scheduler.schedule('a.ts', 'update');
    scheduler.schedule('a.ts', 'remove');
    vi.runAllTimers();
    expect(calls).toEqual([['a.ts', 'remove']]);
  });

  it('debounces files independently', () => {
    scheduler.schedule('a.ts', 'update');
    scheduler.schedule('b.ts', 'remove');
    expect(scheduler.pendingCount).toBe(2);
    vi.runAllTimers();
    expect(calls).toEqual([
      ['a.ts', 'update'],
      ['b.ts', 'remove'],
    ]);
  });

  it('cancels pending changes on dispose', () => {
    scheduler.schedule('a.ts', 'update');
    scheduler.dispose();
    vi.runAllTimers();
    expect(calls).toEqual([]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('accepts a custom delay', () => {
    const custom = new ChangeScheduler((filePath, kind) => {
      calls.push([filePath, kind]);
    }, 50);
    custom.schedule('c.ts', 'update');
    vi.advanceTimersByTime(50);
    expect(calls).toEqual([['c.ts', 'update']]);
  });
});
