import { describe, expect, it } from 'vitest';

import { parseSource } from './analyzer/parser';
import type { ParsedFile } from './analyzer/types';
import { AnalysisCache, hashContent } from './cache';

/**
 * Creates a cache whose parser counts its invocations.
 *
 * @returns The cache and a function returning the parse count.
 */
function createCountingCache(): { cache: AnalysisCache; parseCount: () => number } {
  let count = 0;
  const cache = new AnalysisCache((filePath, content): ParsedFile => {
    count += 1;
    return parseSource(filePath, content);
  });
  return { cache, parseCount: () => count };
}

describe('hashContent', () => {
  it('returns the SHA-256 hex digest', () => {
    expect(hashContent('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('AnalysisCache', () => {
  it('parses new files', () => {
    const { cache, parseCount } = createCountingCache();
    const result = cache.update('a.ts', 'function a() {}');
    expect(result.changed).toBe(true);
    expect(result.parsed.functions.map((fn) => fn.name)).toEqual(['a']);
    expect(parseCount()).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('skips parsing when the content hash is unchanged', () => {
    const { cache, parseCount } = createCountingCache();
    const first = cache.update('a.ts', 'function a() {}');
    const second = cache.update('a.ts', 'function a() {}');
    expect(second.changed).toBe(false);
    expect(second.parsed).toBe(first.parsed);
    expect(parseCount()).toBe(1);
  });

  it('re-parses when the content changes', () => {
    const { cache, parseCount } = createCountingCache();
    cache.update('a.ts', 'function a() {}');
    const result = cache.update('a.ts', 'function b() {}');
    expect(result.changed).toBe(true);
    expect(result.parsed.functions.map((fn) => fn.name)).toEqual(['b']);
    expect(parseCount()).toBe(2);
  });

  it('caches files independently', () => {
    const { cache, parseCount } = createCountingCache();
    cache.update('a.ts', 'same');
    expect(cache.update('b.ts', 'same').changed).toBe(true);
    expect(parseCount()).toBe(2);
  });

  it('gets, deletes, lists and clears entries', () => {
    const cache = new AnalysisCache();
    cache.update('a.ts', '');
    cache.update('b.ts', '');
    expect(cache.get('a.ts')?.filePath).toBe('a.ts');
    expect(cache.get('zzz.ts')).toBeUndefined();
    expect(cache.getAll().map((file) => file.filePath)).toEqual(['a.ts', 'b.ts']);
    expect(cache.delete('a.ts')).toBe(true);
    expect(cache.delete('a.ts')).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
