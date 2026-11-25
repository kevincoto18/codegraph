import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode, GraphSnapshot, ReviewResult } from '../shared';
import {
  computeImpact,
  formatReviewSummary,
  getReviewDisplay,
  indexUsers,
  listReviewEntries,
  reviewChangedIds,
  reviewClassOfEdge,
  reviewClassOfNode,
} from './review';
import { fileNode, functionNode } from './testFixtures';

/**
 * Creates an edge.
 *
 * @param kind - Edge kind.
 * @param source - Source id.
 * @param target - Target id.
 * @returns The edge.
 */
function edge(kind: GraphEdge['kind'], source: string, target: string): GraphEdge {
  return { id: `${kind}:${source}->${target}`, kind, source, target };
}

// cli.ts → app.ts#start → service.ts#save → repo.ts#write; util.ts unrelated.
const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    fileNode('cli.ts', ['cli.ts#main']),
    functionNode('cli.ts', 'main'),
    fileNode('app.ts', ['app.ts#start']),
    functionNode('app.ts', 'start'),
    fileNode('service.ts', ['service.ts#save']),
    functionNode('service.ts', 'save'),
    fileNode('repo.ts', ['repo.ts#write']),
    functionNode('repo.ts', 'write'),
    fileNode('util.ts'),
  ],
  edges: [
    edge('call', 'cli.ts#main', 'app.ts#start'),
    edge('call', 'app.ts#start', 'service.ts#save'),
    edge('call', 'service.ts#save', 'repo.ts#write'),
    edge('import', 'service.ts', 'repo.ts'),
  ],
};

const RESULT: ReviewResult = {
  mode: 'base',
  base: 'main · 1a2b3c4',
  truncated: false,
  files: [
    {
      filePath: 'repo.ts',
      status: 'modified',
      added: 4,
      removed: 1,
      inGraph: true,
      topLevel: false,
      functions: [{ nodeId: 'repo.ts#write', added: 4, removed: 1 }],
    },
    {
      filePath: 'util.ts',
      status: 'modified',
      added: 1,
      removed: 0,
      inGraph: true,
      topLevel: true,
      functions: [],
    },
    {
      filePath: 'README.md',
      status: 'modified',
      added: 2,
      removed: 0,
      inGraph: false,
      topLevel: false,
      functions: [],
    },
  ],
};

const USERS = indexUsers(SNAPSHOT);
const BY_ID = new Map<string, GraphNode>(SNAPSHOT.nodes.map((node) => [node.id, node]));

describe('computeImpact', () => {
  it('follows callers and importers up to the depth', () => {
    const changed = reviewChangedIds(RESULT);
    expect([...changed]).toEqual(['repo.ts#write', 'util.ts']);
    const impact = computeImpact(USERS, changed, 2);
    expect(Object.fromEntries(impact.levels)).toEqual({
      'repo.ts#write': 0,
      'util.ts': 0,
      'service.ts#save': 1,
      'app.ts#start': 2,
    });
    expect([impact.changed, impact.affected]).toEqual([2, 2]);
    expect(computeImpact(USERS, changed, 3).levels.get('cli.ts#main')).toBe(3);
  });
});

describe('listReviewEntries', () => {
  it('does not count other changes as affected, nor list new files twice', () => {
    const result: ReviewResult = {
      ...RESULT,
      files: [
        {
          filePath: 'service.ts',
          status: 'modified',
          added: 1,
          removed: 0,
          inGraph: true,
          topLevel: false,
          functions: [{ nodeId: 'service.ts#save', added: 1, removed: 0 }],
        },
        {
          filePath: 'repo.ts',
          status: 'added',
          added: 5,
          removed: 0,
          inGraph: true,
          topLevel: true,
          functions: [{ nodeId: 'repo.ts#write', added: 3, removed: 0 }],
        },
      ],
    };
    const entries = listReviewEntries(result, BY_ID, USERS, 2);
    expect(entries.map((entry) => [entry.label, entry.affected])).toEqual([
      ['save', 2],
      ['write', 1],
    ]);
  });

  it('ranks changes by how much they affect', () => {
    const entries = listReviewEntries(RESULT, BY_ID, USERS, 2);
    expect(entries.map((entry) => [entry.label, entry.kind, entry.affected])).toEqual([
      ['write', 'function', 2],
      ['util.ts', 'file', 0],
    ]);
  });
});

describe('review display', () => {
  it('colors files by their strongest function and dims the rest', () => {
    const impact = computeImpact(USERS, reviewChangedIds(RESULT), 1);
    const display = getReviewDisplay(SNAPSHOT, impact, null);
    expect(reviewClassOfNode('repo.ts', 'file', display)).toBe('cg-review-changed');
    expect(reviewClassOfNode('service.ts', 'file', display)).toBe('cg-review-direct');
    expect(reviewClassOfNode('app.ts', 'file', display)).toBe('cg-focus-dimmed');
    expect(reviewClassOfNode('x', 'file', null)).toBeUndefined();
    expect(reviewClassOfEdge('service.ts#save', 'repo.ts#write', display)).toBe('cg-review-edge');
    expect(reviewClassOfEdge('repo.ts#write', 'service.ts#save', display)).toBe('cg-focus-dimmed');
  });
});

describe('formatReviewSummary', () => {
  it('summarizes the changes as Markdown', () => {
    const impact = computeImpact(USERS, reviewChangedIds(RESULT), 2);
    const text = formatReviewSummary(RESULT, listReviewEntries(RESULT, BY_ID, USERS, 2), impact, 2);
    expect(text).toContain('Compared with `main · 1a2b3c4`: 3 files changed (+7 −1)');
    expect(text).toContain('| `write()` | repo.ts | +4 −1 | 2 |');
    expect(text).toContain('Not analyzed: README.md (modified).');
  });
});
