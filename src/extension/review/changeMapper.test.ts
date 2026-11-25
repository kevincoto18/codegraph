import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../../shared';
import { fileNode, functionNode } from '../../webview/testFixtures';
import { mapChanges } from './changeMapper';
import { parseUnifiedDiff } from './diffParser';

// a.ts: imports (1-2), outer (4-20) containing inner (8-12), helper (22-30).
const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    fileNode('a.ts', ['a.ts#outer', 'a.ts#outer.inner', 'a.ts#helper']),
    functionNode('a.ts', 'outer', 4, { endLine: 20 }),
    functionNode('a.ts', 'outer.inner', 8, { endLine: 12 }),
    functionNode('a.ts', 'helper', 22, { endLine: 30 }),
    fileNode('b.ts', ['b.ts#run']),
    functionNode('b.ts', 'run', 1, { endLine: 5 }),
  ],
  edges: [],
};

/**
 * Builds a one-hunk diff.
 *
 * @param start - First new line of the hunk.
 * @param lines - Hunk lines (with their marker).
 * @returns The parsed diff.
 */
function hunk(start: number, lines: string[]): ReturnType<typeof parseUnifiedDiff> {
  return parseUnifiedDiff([`@@ -${String(start)},9 +${String(start)},9 @@`, ...lines].join('\n'));
}

describe('mapChanges', () => {
  it('assigns changed lines to the innermost function and flags top-level changes', () => {
    const [file] = mapChanges(SNAPSHOT, [
      {
        filePath: 'a.ts',
        status: 'modified',
        diff: hunk(1, ['+import z', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '-old', '+new', ' ']),
      },
    ]);
    expect(file).toMatchObject({ topLevel: true, inGraph: true, added: 2, removed: 1 });
    expect(file?.functions).toEqual([{ nodeId: 'a.ts#outer.inner', added: 1, removed: 1 }]);
  });

  it('keeps a removal between two functions out of both', () => {
    const [file] = mapChanges(SNAPSHOT, [
      {
        filePath: 'a.ts',
        status: 'modified',
        diff: hunk(20, [' }', '-function gone() {}', ' ', ' x']),
      },
    ]);
    expect(file?.functions).toEqual([]);
    expect(file?.topLevel).toBe(true);
  });

  it('attributes a replaced line to the function it is in now', () => {
    const [file] = mapChanges(SNAPSHOT, [
      {
        filePath: 'a.ts',
        status: 'modified',
        diff: hunk(22, ['-old header', '+new header', ' x']),
      },
    ]);
    expect(file?.functions).toEqual([{ nodeId: 'a.ts#helper', added: 1, removed: 1 }]);
    expect(file?.topLevel).toBe(false);
  });

  it('ignores blank lines and comments outside functions', () => {
    const [file] = mapChanges(SNAPSHOT, [
      { filePath: 'a.ts', status: 'modified', diff: hunk(31, ['+', '+/** Helper. */', ' x']) },
    ]);
    expect(file).toMatchObject({ topLevel: false, added: 2, functions: [] });
  });

  it('counts a removal inside a function', () => {
    const [file] = mapChanges(SNAPSHOT, [
      { filePath: 'a.ts', status: 'modified', diff: hunk(23, [' a', '-b', ' c']) },
    ]);
    expect(file?.functions).toEqual([{ nodeId: 'a.ts#helper', added: 0, removed: 1 }]);
    expect(file?.topLevel).toBe(false);
  });

  it('marks everything in a new file without diff', () => {
    const [file] = mapChanges(SNAPSHOT, [
      { filePath: 'b.ts', status: 'added', diff: null, lineCount: 9 },
    ]);
    expect(file).toMatchObject({ added: 9, topLevel: true });
    expect(file?.functions).toEqual([{ nodeId: 'b.ts#run', added: 5, removed: 0 }]);
  });

  it('lists files outside the graph last, without functions', () => {
    const files = mapChanges(SNAPSHOT, [
      { filePath: 'README.md', status: 'modified', diff: hunk(1, ['+x']) },
      { filePath: 'gone.ts', status: 'deleted', diff: hunk(1, ['-x', '-y']) },
      { filePath: 'b.ts', status: 'modified', diff: hunk(2, ['+x']) },
    ]);
    expect(files.map((file) => [file.filePath, file.inGraph])).toEqual([
      ['b.ts', true],
      ['gone.ts', false],
      ['README.md', false],
    ]);
    expect(files[1]).toMatchObject({ removed: 2, topLevel: false, functions: [] });
  });
});
