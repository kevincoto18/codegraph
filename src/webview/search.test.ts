import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import {
  decorateEdges,
  decorateNodes,
  formatMatchCount,
  getSearchRole,
  matchNodes,
  normalizeQuery,
} from './search';

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

describe('normalizeQuery', () => {
  it('trims and lower-cases', () => {
    expect(normalizeQuery('  SaveUser ')).toBe('saveuser');
  });
});

describe('matchNodes', () => {
  it('returns null for an empty query', () => {
    expect(matchNodes(SNAPSHOT, '   ')).toBeNull();
  });

  it('matches functions case-insensitively and highlights their file', () => {
    const result = matchNodes(SNAPSHOT, 'save');
    expect(result?.matchedIds).toEqual(new Set(['src/user.ts#saveUser']));
    expect(result?.highlightedIds).toEqual(new Set(['src/user.ts#saveUser', 'src/user.ts']));
  });

  it('matches qualified method names', () => {
    expect(matchNodes(SNAPSHOT, 'service.lo')?.matchedIds).toEqual(
      new Set(['src/user.ts#UserService.load']),
    );
  });

  it('matches files by path without matching every function inside', () => {
    expect(matchNodes(SNAPSHOT, 'src/db')?.matchedIds).toEqual(new Set(['src/db.ts']));
    expect(matchNodes(SNAPSHOT, 'user.ts')?.matchedIds).toEqual(new Set(['src/user.ts']));
  });

  it('reports no matches', () => {
    expect(matchNodes(SNAPSHOT, 'nothing')?.matchedIds.size).toBe(0);
  });
});

describe('search decoration', () => {
  const search = matchNodes(SNAPSHOT, 'save');
  if (search === null) {
    throw new Error('Expected an active search.');
  }

  it('classifies nodes as match, context or dimmed', () => {
    expect(getSearchRole('src/user.ts#saveUser', search)).toBe('match');
    expect(getSearchRole('src/user.ts', search)).toBe('context');
    expect(getSearchRole('src/db.ts', search)).toBe('dimmed');
  });

  it('adds classes to nodes only while searching', () => {
    const nodes = [{ id: 'src/user.ts#saveUser' }, { id: 'src/user.ts' }, { id: 'src/db.ts' }];
    expect(decorateNodes(nodes, null)).toBe(nodes);
    expect(decorateNodes(nodes, search)).toEqual([
      { id: 'src/user.ts#saveUser', className: 'cg-match' },
      { id: 'src/user.ts', className: 'cg-context' },
      { id: 'src/db.ts', className: 'cg-dimmed' },
    ]);
  });

  it('dims edges unless both endpoints are highlighted', () => {
    const edges = [
      { source: 'src/user.ts', target: 'src/user.ts#saveUser', className: 'cg-edge' },
      { source: 'src/user.ts', target: 'src/db.ts', className: 'cg-edge' },
    ];
    expect(decorateEdges(edges, null)).toBe(edges);
    expect(decorateEdges(edges, search).map((edge) => edge.className)).toEqual([
      'cg-edge',
      'cg-edge cg-dimmed',
    ]);
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
