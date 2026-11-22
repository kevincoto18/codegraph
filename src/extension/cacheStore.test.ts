import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CacheEntry } from './cache';
import type { GraphSnapshot } from '../shared';
import { FileCacheStore, FileGraphStore, isPersistedCache, isPersistedGraph } from './cacheStore';

/** Entry used by every test. */
const ENTRY: CacheEntry = {
  filePath: 'a.ts',
  hash: 'abc',
  stamp: { mtime: 1, size: 2 },
  parsed: { filePath: 'a.ts', imports: [], functions: [], exports: [] },
};

/** Logger that records warnings. */
const warnings: string[] = [];
const logger = {
  /**
   * Records a warning.
   *
   * @param message - Warning text.
   */
  warn: (message: string): void => {
    warnings.push(message);
  },
};

describe('FileCacheStore', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'codegraph-cache-'));
    warnings.length = 0;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('round-trips entries', async () => {
    const store = new FileCacheStore(join(directory, 'nested', 'cache.bin'), 'k1', logger);
    await store.save([ENTRY]);
    expect(await store.load()).toEqual([ENTRY]);
  });

  it('returns nothing when the file is missing', async () => {
    const store = new FileCacheStore(join(directory, 'missing.bin'), 'k1', logger);
    expect(await store.load()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('discards a cache written with another key', async () => {
    const path = join(directory, 'cache.bin');
    await new FileCacheStore(path, 'old', logger).save([ENTRY]);
    expect(await new FileCacheStore(path, 'new', logger).load()).toEqual([]);
  });

  it('ignores corrupt files with a warning', async () => {
    const path = join(directory, 'cache.bin');
    await writeFile(path, 'not a v8 payload');
    expect(await new FileCacheStore(path, 'k1', logger).load()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe('isPersistedCache', () => {
  it('validates shape and key', () => {
    expect(isPersistedCache({ key: 'k', entries: [] }, 'k')).toBe(true);
    expect(isPersistedCache({ key: 'k', entries: {} }, 'k')).toBe(false);
    expect(isPersistedCache({ key: 'x', entries: [] }, 'k')).toBe(false);
    expect(isPersistedCache(null, 'k')).toBe(false);
  });
});

/** Small graph used by the graph store tests. */
const GRAPH: GraphSnapshot = {
  version: 4,
  nodes: [
    { id: 'a.ts', kind: 'file', label: 'a.ts', filePath: 'a.ts', line: 1, functionIds: [] },
    { id: 'b.ts', kind: 'file', label: 'b.ts', filePath: 'b.ts', line: 1, functionIds: [] },
  ],
  edges: [{ id: 'import:a.ts->b.ts', kind: 'import', source: 'a.ts', target: 'b.ts', line: 1 }],
};

describe('FileGraphStore', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'codegraph-graph-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('round-trips a graph', async () => {
    const store = new FileGraphStore(join(directory, 'graph.bin'), 'k', logger);
    await store.save(GRAPH);
    expect(await store.load()).toEqual(GRAPH);
  });

  it('returns null when missing or written with another key', async () => {
    const path = join(directory, 'graph.bin');
    expect(await new FileGraphStore(path, 'k', logger).load()).toBeNull();
    await new FileGraphStore(path, 'old', logger).save(GRAPH);
    expect(await new FileGraphStore(path, 'new', logger).load()).toBeNull();
  });

  it('validates the persisted shape', () => {
    expect(isPersistedGraph({ key: 'k', version: 1, chunks: [] }, 'k')).toBe(true);
    expect(isPersistedGraph({ key: 'k', version: 0, chunks: [] }, 'k')).toBe(false);
    expect(isPersistedGraph({ key: 'k', version: 1 }, 'k')).toBe(false);
  });
});
