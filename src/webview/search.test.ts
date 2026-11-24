import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import {
  formatMatchCount,
  getSearchRole,
  searchClassOfEdge,
  searchClassOfNode,
  normalizeQuery,
  toSearchResult,
  withFolderContext,
} from './search';
import type { SearchResult } from './search';
import { buildSearchIndex, searchIndex } from './searchIndex';
import { buildFolderTree } from './folders';

/** Two files; `user.ts` has `saveUser` and `UserService.load`. */
const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    {
      id: 'src/user.ts',
      kind: 'file',
      label: 'user.ts',
      filePath: 'src/user.ts',
      line: 1,
      functionIds: ['src/user.ts#saveUser', 'src/user.ts#UserService.load'],
    },
    {
      id: 'src/user.ts#saveUser',
      kind: 'function',
      label: 'saveUser',
      filePath: 'src/user.ts',
      line: 2,
      fileId: 'src/user.ts',
      qualifiedName: 'saveUser',
      functionKind: 'function',
      endLine: 3,
      exported: true,
    },
    {
      id: 'src/user.ts#UserService.load',
      kind: 'function',
      label: 'UserService.load',
      filePath: 'src/user.ts',
      line: 5,
      fileId: 'src/user.ts',
      qualifiedName: 'UserService.load',
      functionKind: 'method',
      endLine: 6,
      exported: true,
    },
    {
      id: 'src/db.ts',
      kind: 'file',
      label: 'db.ts',
      filePath: 'src/db.ts',
      line: 1,
      functionIds: [],
    },
  ],
  edges: [],
};

/**
 * Runs a query against {@link SNAPSHOT}.
 *
 * @param query - Query.
 * @returns The ids to highlight.
 */
function matchNodes(query: string): SearchResult | null {
  return toSearchResult(searchIndex(buildSearchIndex(SNAPSHOT), query), query);
}

describe('normalizeQuery', () => {
  it('trims and lower-cases', () => {
    expect(normalizeQuery('  SaveUser ')).toBe('saveuser');
  });
});

describe('toSearchResult', () => {
  it('returns null for an empty query', () => {
    expect(matchNodes('   ')).toBeNull();
  });

  it('matches functions case-insensitively and highlights their file', () => {
    const result = matchNodes('save');
    expect(result?.matchedIds).toEqual(new Set(['src/user.ts#saveUser']));
    expect(result?.highlightedIds).toEqual(new Set(['src/user.ts#saveUser', 'src/user.ts']));
  });

  it('matches qualified method names', () => {
    expect(matchNodes('service.lo')?.matchedIds).toEqual(new Set(['src/user.ts#UserService.load']));
  });

  it('matches files by path without matching every function inside', () => {
    expect(matchNodes('src/db')?.matchedIds).toEqual(new Set(['src/db.ts']));
    expect(matchNodes('user.ts')?.matchedIds).toEqual(new Set(['src/user.ts']));
  });

  it('reports no matches', () => {
    expect(matchNodes('nothing')?.matchedIds.size).toBe(0);
  });
});

describe('search decoration', () => {
  const search = matchNodes('save');
  if (search === null) {
    throw new Error('Expected an active search.');
  }

  it('classifies nodes as match, context or dimmed', () => {
    expect(getSearchRole('src/user.ts#saveUser', search)).toBe('match');
    expect(getSearchRole('src/user.ts', search)).toBe('context');
    expect(getSearchRole('src/db.ts', search)).toBe('dimmed');
  });

  it('resolves node classes only while searching', () => {
    expect(searchClassOfNode('src/user.ts#saveUser', null)).toBeUndefined();
    expect(searchClassOfNode('src/user.ts#saveUser', search)).toBe('cg-match');
    expect(searchClassOfNode('src/user.ts', search)).toBe('cg-context');
    expect(searchClassOfNode('src/db.ts', search)).toBe('cg-dimmed');
  });

  it('dims edges unless both endpoints are highlighted', () => {
    const inside = { source: 'src/user.ts', target: 'src/user.ts#saveUser' };
    const outside = { source: 'src/user.ts', target: 'src/db.ts' };
    expect(searchClassOfEdge(outside, null)).toBeUndefined();
    expect(searchClassOfEdge(inside, search)).toBeUndefined();
    expect(searchClassOfEdge(outside, search)).toBe('cg-dimmed');
  });
});

describe('formatMatchCount', () => {
  it.each([
    [0, 'No matches'],
    [1, '1 match'],
    [12, '12 matches'],
  ])('formats %i as "%s"', (count, expected) => {
    expect(formatMatchCount(count)).toBe(expected);
  });
});

describe('withFolderContext', () => {
  it('highlights the folders that contain highlighted files', () => {
    const search = matchNodes('save');
    const tree = buildFolderTree(SNAPSHOT.nodes);
    const extended = withFolderContext(search, tree);
    expect(extended?.matchedIds).toEqual(search?.matchedIds);
    expect(extended?.highlightedIds.has('folder:src')).toBe(true);
    expect(withFolderContext(search, null)).toBe(search);
    expect(withFolderContext(null, tree)).toBeNull();
  });
});
