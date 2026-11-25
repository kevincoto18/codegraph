import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphSnapshot } from '../shared';
import { findUnusedCode } from './deadCode';
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

const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    fileNode('src/index.ts', ['src/index.ts#main']),
    functionNode('src/index.ts', 'main'),
    fileNode('src/service.ts', [
      'src/service.ts#register',
      'src/service.ts#legacyExport',
      'src/service.ts#helper',
      'src/service.ts#unusedHelper',
    ]),
    functionNode('src/service.ts', 'register', 1, { exported: true }),
    functionNode('src/service.ts', 'legacyExport', 5, { exported: true }),
    functionNode('src/service.ts', 'helper', 9),
    functionNode('src/service.ts', 'unusedHelper', 12),
    fileNode('src/repo.ts', ['src/repo.ts#Repository.save', 'src/repo.ts#MemoryRepo.save']),
    functionNode('src/repo.ts', 'Repository.save'),
    functionNode('src/repo.ts', 'MemoryRepo.save'),
    fileNode('src/old.ts', ['src/old.ts#oldThing']),
    functionNode('src/old.ts', 'oldThing'),
    fileNode('src/Card.tsx', ['src/Card.tsx#Card']),
    functionNode('src/Card.tsx', 'Card'),
    fileNode('src/service.test.ts', ['src/service.test.ts#testRegister']),
    functionNode('src/service.test.ts', 'testRegister'),
    fileNode('app/models.py', ['app/models.py#User.__str__']),
    functionNode('app/models.py', 'User.__str__'),
  ],
  edges: [
    edge('import', 'src/index.ts', 'src/service.ts'),
    edge('call', 'src/index.ts#main', 'src/service.ts#register'),
    edge('call', 'src/service.ts#register', 'src/service.ts#helper'),
    edge('call', 'src/service.ts#register', 'src/repo.ts#Repository.save'),
    edge('call', 'src/service.ts#unusedHelper', 'src/service.ts#unusedHelper'),
  ],
};

describe('findUnusedCode', () => {
  const unused = findUnusedCode(SNAPSHOT);

  it('lists functions that are never called', () => {
    expect(unused.functions.map((fn) => fn.id)).toEqual([
      'src/service.ts#legacyExport',
      'src/service.ts#unusedHelper',
      'src/old.ts#oldThing',
    ]);
  });

  it('leaves out entry points, components, tests, dunders and possible interface implementations', () => {
    const ids = unused.ids;
    expect(ids.has('src/index.ts#main')).toBe(false);
    expect(ids.has('src/Card.tsx#Card')).toBe(false);
    expect(ids.has('src/service.test.ts#testRegister')).toBe(false);
    expect(ids.has('app/models.py#User.__str__')).toBe(false);
    // `Repository.save` is called, so `MemoryRepo.save` may run through it.
    expect(ids.has('src/repo.ts#MemoryRepo.save')).toBe(false);
  });

  it('lists files that nothing imports or calls into, except entry and test files', () => {
    expect(unused.files.map((file) => file.id)).toEqual([
      'src/old.ts',
      'src/Card.tsx',
      'app/models.py',
    ]);
  });
});
