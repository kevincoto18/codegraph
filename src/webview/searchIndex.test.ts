import { describe, expect, it } from 'vitest';

import type { FileGraphNode, FunctionGraphNode, GraphSnapshot } from '../shared';
import {
  buildSearchIndex,
  computeBoundaries,
  searchIndex,
  splitHighlights,
  tokenizeQuery,
} from './searchIndex';

/**
 * Builds a file node.
 *
 * @param path - File path (also its id).
 * @returns The node.
 */
function file(path: string): FileGraphNode {
  return { id: path, kind: 'file', label: path, filePath: path, line: 1, functionIds: [] };
}

/**
 * Builds a function node.
 *
 * @param path - File path.
 * @param name - Qualified name.
 * @returns The node.
 */
function fn(path: string, name: string): FunctionGraphNode {
  return {
    id: `${path}#${name}`,
    kind: 'function',
    label: name,
    filePath: path,
    line: 1,
    fileId: path,
    qualifiedName: name,
    functionKind: 'function',
    endLine: 2,
    exported: true,
  };
}

const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    file('src/webview/GraphView.tsx'),
    fn('src/webview/GraphView.tsx', 'GraphViewContent'),
    fn('src/webview/GraphView.tsx', 'GraphView'),
    fn('src/webview/search.ts', 'gravityCheck'),
    fn('src/user.ts', 'UserService.save'),
    fn('src/user.ts', 'saveUser'),
    file('src/user.ts'),
  ],
  edges: [],
};

const INDEX = buildSearchIndex(SNAPSHOT);

/**
 * Names of the hits of a query, best first.
 *
 * @param query - Query.
 * @returns The hit names.
 */
function names(query: string): string[] {
  return searchIndex(INDEX, query).map((hit) => hit.entry.name);
}

describe('computeBoundaries', () => {
  it('marks camelCase humps, separators and digits', () => {
    expect([...computeBoundaries('getUser.save_v2')]).toEqual([
      1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1,
    ]);
  });
});

describe('searchIndex', () => {
  it('returns nothing for a blank query', () => {
    expect(searchIndex(INDEX, '   ')).toEqual([]);
  });

  it('ranks exact names before prefixes and substrings', () => {
    expect(names('graphview').slice(0, 3)).toEqual([
      'GraphView',
      'GraphView.tsx',
      'GraphViewContent',
    ]);
  });

  it('matches initials of camelCase names', () => {
    const [first] = searchIndex(INDEX, 'gvc');
    expect(first?.entry.name).toBe('GraphViewContent');
    expect(first?.positions).toEqual([0, 5, 9]);
  });

  it('ranks initials above loose subsequences', () => {
    expect(names('gvc')).toEqual(['GraphViewContent', 'gravityCheck']);
  });

  it('requires every token to match', () => {
    expect(names('user save')).toEqual(['saveUser', 'UserService.save']);
  });

  it('finds files by folder without matching their functions', () => {
    expect(names('webview')).toEqual(['GraphView.tsx']);
  });

  it('describes files by folder and functions by file', () => {
    const [hit] = searchIndex(INDEX, 'user.ts');
    expect(hit?.entry).toMatchObject({ kind: 'file', name: 'user.ts', detail: 'src' });
  });
});

describe('helpers', () => {
  it('tokenizes queries', () => {
    expect(tokenizeQuery('  User  Save ')).toEqual(['user', 'save']);
  });

  it('splits names into highlighted segments', () => {
    expect(splitHighlights('GraphView', [0, 5, 6])).toEqual([
      { text: 'G', highlighted: true },
      { text: 'raph', highlighted: false },
      { text: 'Vi', highlighted: true },
      { text: 'ew', highlighted: false },
    ]);
  });
});
