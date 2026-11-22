import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import { resolveFocusTarget } from './focusTarget';

/** A file with a class method inside a wider function range. */
const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    {
      id: 'a.ts',
      kind: 'file',
      label: 'a.ts',
      filePath: 'a.ts',
      line: 1,
      functionIds: ['a.ts#outer', 'a.ts#Box.run'],
    },
    {
      id: 'a.ts#outer',
      kind: 'function',
      label: 'outer',
      filePath: 'a.ts',
      line: 1,
      endLine: 20,
      fileId: 'a.ts',
      qualifiedName: 'outer',
      functionKind: 'function',
      exported: true,
    },
    {
      id: 'a.ts#Box.run',
      kind: 'function',
      label: 'Box.run',
      filePath: 'a.ts',
      line: 5,
      endLine: 8,
      fileId: 'a.ts',
      qualifiedName: 'Box.run',
      functionKind: 'method',
      exported: true,
    },
  ],
  edges: [],
};

describe('resolveFocusTarget', () => {
  it('picks the innermost function around the cursor', () => {
    expect(resolveFocusTarget(SNAPSHOT, 'a.ts', 6)).toBe('a.ts#Box.run');
    expect(resolveFocusTarget(SNAPSHOT, 'a.ts', 15)).toBe('a.ts#outer');
  });

  it('falls back to the file outside functions or without a line', () => {
    expect(resolveFocusTarget(SNAPSHOT, 'a.ts', 30)).toBe('a.ts');
    expect(resolveFocusTarget(SNAPSHOT, 'a.ts')).toBe('a.ts');
  });

  it('returns null for files outside the graph', () => {
    expect(resolveFocusTarget(SNAPSHOT, 'b.ts', 1)).toBeNull();
  });
});
