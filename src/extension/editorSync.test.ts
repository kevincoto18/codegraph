import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorSyncScheduler } from './editorSync';

describe('EditorSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers only the latest location once the cursor is still', () => {
    const deliver = vi.fn();
    const scheduler = new EditorSyncScheduler<string>(deliver, 100);
    scheduler.schedule({ uri: 'a.ts', line: 1 });
    vi.advanceTimersByTime(60);
    scheduler.schedule({ uri: 'a.ts', line: 5 });
    vi.advanceTimersByTime(60);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ uri: 'a.ts', line: 5 });
  });

  it('drops the pending location when cancelled', () => {
    const deliver = vi.fn();
    const scheduler = new EditorSyncScheduler<string>(deliver, 100);
    scheduler.schedule({ uri: 'a.ts', line: 1 });
    scheduler.cancel();
    vi.advanceTimersByTime(200);
    expect(deliver).not.toHaveBeenCalled();
  });
});
