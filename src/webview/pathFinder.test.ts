import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphSnapshot } from '../shared';
import { findShortestPath, getPathDisplay, pathClassOfNode, pathStepKey } from './pathFinder';
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

// app.ts#start → service.ts#register → repo.ts#save (calls), plus a shortcut
// that does not reach save, and imports between the files.
const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    fileNode('app.ts', ['app.ts#start']),
    functionNode('app.ts', 'start'),
    fileNode('service.ts', ['service.ts#register', 'service.ts#log']),
    functionNode('service.ts', 'register'),
    functionNode('service.ts', 'log'),
    fileNode('repo.ts', ['repo.ts#save']),
    functionNode('repo.ts', 'save'),
    fileNode('util.ts', ['util.ts#pad']),
    functionNode('util.ts', 'pad'),
    fileNode('lonely.ts'),
  ],
  edges: [
    edge('import', 'app.ts', 'service.ts'),
    edge('import', 'service.ts', 'repo.ts'),
    edge('call', 'app.ts#start', 'service.ts#register'),
    edge('call', 'app.ts#start', 'service.ts#log'),
    edge('call', 'service.ts#register', 'repo.ts#save'),
    edge('call', 'repo.ts#save', 'util.ts#pad'),
  ],
};

describe('findShortestPath', () => {
  it('follows calls between functions', () => {
    expect(findShortestPath(SNAPSHOT, 'app.ts#start', 'repo.ts#save')).toEqual({
      nodeIds: ['app.ts#start', 'service.ts#register', 'repo.ts#save'],
      edgeIds: ['call:app.ts#start->service.ts#register', 'call:service.ts#register->repo.ts#save'],
      reversed: false,
      level: 'function',
    });
  });

  it('finds the path backwards when it only exists the other way', () => {
    const path = findShortestPath(SNAPSHOT, 'repo.ts#save', 'app.ts#start');
    expect(path?.reversed).toBe(true);
    expect(path?.nodeIds).toEqual(['app.ts#start', 'service.ts#register', 'repo.ts#save']);
  });

  it('runs between files when an end is a file, preferring imports', () => {
    expect(findShortestPath(SNAPSHOT, 'app.ts', 'repo.ts')).toEqual({
      nodeIds: ['app.ts', 'service.ts', 'repo.ts'],
      edgeIds: ['import:app.ts->service.ts', 'import:service.ts->repo.ts'],
      reversed: false,
      level: 'file',
    });
    // Calls are lifted to their files (no import from repo.ts to util.ts).
    expect(findShortestPath(SNAPSHOT, 'app.ts#start', 'util.ts')?.nodeIds).toEqual([
      'app.ts',
      'service.ts',
      'repo.ts',
      'util.ts',
    ]);
  });

  it('returns null when the nodes are not connected or are the same', () => {
    expect(findShortestPath(SNAPSHOT, 'app.ts', 'lonely.ts')).toBeNull();
    expect(findShortestPath(SNAPSHOT, 'service.ts#log', 'repo.ts#save')).toBeNull();
    expect(findShortestPath(SNAPSHOT, 'app.ts', 'app.ts')).toBeNull();
    expect(findShortestPath(SNAPSHOT, 'app.ts#start', 'app.ts')).toBeNull();
    expect(findShortestPath(SNAPSHOT, 'missing', 'app.ts')).toBeNull();
  });
});

describe('getPathDisplay', () => {
  it('lights the path, its ends, its containers and its steps', () => {
    const path = findShortestPath(SNAPSHOT, 'app.ts#start', 'repo.ts#save');
    expect(path).not.toBeNull();
    if (path === null) {
      return;
    }
    const display = getPathDisplay(
      [
        { id: 'folder:src' },
        { id: 'app.ts', parentId: 'folder:src' },
        { id: 'app.ts#start', parentId: 'app.ts' },
        { id: 'service.ts' },
        { id: 'service.ts#register', parentId: 'service.ts' },
        { id: 'repo.ts' },
        { id: 'repo.ts#save', parentId: 'repo.ts' },
        { id: 'util.ts' },
      ],
      path,
    );
    expect([...display.endIds]).toEqual(['app.ts#start', 'repo.ts#save']);
    expect([...display.containerIds].sort()).toEqual([
      'app.ts',
      'folder:src',
      'repo.ts',
      'service.ts',
    ]);
    expect(display.steps.has(pathStepKey('app.ts#start', 'service.ts#register'))).toBe(true);
    expect(display.steps.has(pathStepKey('service.ts#register', 'app.ts#start'))).toBe(false);
    expect(pathClassOfNode('app.ts#start', display)).toBe('cg-path-node cg-path-end');
    expect(pathClassOfNode('service.ts#register', display)).toBe('cg-path-node');
    expect(pathClassOfNode('folder:src', display)).toBeUndefined();
    expect(pathClassOfNode('util.ts', display)).toBe('cg-focus-dimmed');
    expect(pathClassOfNode('util.ts', null)).toBeUndefined();
  });
});
