import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphSnapshot } from '../shared';
import { fileNode, functionNode } from '../webview/testFixtures';
import { computeMiniGraph } from './miniGraph';

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
    fileNode('src/app.ts', ['src/app.ts#start']),
    functionNode('src/app.ts', 'start', 3),
    fileNode('src/service.ts', ['src/service.ts#register', 'src/service.ts#log']),
    functionNode('src/service.ts', 'register', 10),
    functionNode('src/service.ts', 'log', 2),
    fileNode('src/repo.ts', ['src/repo.ts#save']),
    functionNode('src/repo.ts', 'save'),
    fileNode('src/cli.ts'),
  ],
  edges: [
    edge('import', 'src/app.ts', 'src/service.ts'),
    edge('import', 'src/cli.ts', 'src/service.ts'),
    edge('import', 'src/service.ts', 'src/repo.ts'),
    edge('call', 'src/app.ts#start', 'src/service.ts#register'),
    edge('call', 'src/app.ts#start', 'src/service.ts#log'),
    edge('call', 'src/service.ts#register', 'src/repo.ts#save'),
    edge('call', 'src/service.ts#register', 'src/service.ts#log'),
  ],
};

describe('computeMiniGraph (files)', () => {
  it('lists importers/callers on the left and dependencies on the right', () => {
    const graph = computeMiniGraph(SNAPSHOT, 'src/service.ts', 'files');
    expect(graph?.center).toMatchObject({ label: 'service.ts', detail: 'src', kind: 'file' });
    expect(graph?.incoming.map((node) => [node.label, node.relation, node.weight])).toEqual([
      ['app.ts', 'both', 3],
      ['cli.ts', 'import', 1],
    ]);
    expect(graph?.outgoing.map((node) => [node.label, node.relation])).toEqual([
      ['repo.ts', 'both'],
    ]);
  });

  it('lists members by line and highlights the function under the cursor', () => {
    const graph = computeMiniGraph(SNAPSHOT, 'src/service.ts#register', 'files');
    expect(graph?.center.id).toBe('src/service.ts');
    expect(graph?.members.map((node) => node.label)).toEqual(['log', 'register']);
    expect(graph?.activeId).toBe('src/service.ts#register');
  });

  it('caps each side and reports the rest', () => {
    const graph = computeMiniGraph(SNAPSHOT, 'src/service.ts', 'files', 1);
    expect(graph?.incoming).toHaveLength(1);
    expect(graph?.moreIncoming).toBe(1);
  });

  it('marks the nodes changed in a review', () => {
    const changed = new Set(['src/repo.ts#save', 'src/service.ts#log']);
    const graph = computeMiniGraph(SNAPSHOT, 'src/service.ts', 'files', 6, changed);
    expect(graph?.center.changed).toBe(true);
    expect(graph?.outgoing[0]?.changed).toBe(true);
    expect(graph?.incoming.some((node) => node.changed === true)).toBe(false);
    expect(graph?.members.map((node) => [node.label, node.changed ?? false])).toEqual([
      ['log', true],
      ['register', false],
    ]);
  });

  it('returns null for unknown nodes', () => {
    expect(computeMiniGraph(SNAPSHOT, 'nope.ts', 'files')).toBeNull();
  });
});

describe('computeMiniGraph (functions)', () => {
  it('lists callers and callees, ignoring imports', () => {
    const graph = computeMiniGraph(SNAPSHOT, 'src/service.ts#register', 'functions');
    expect(graph?.center).toMatchObject({ label: 'register', detail: 'service.ts' });
    expect(graph?.incoming.map((node) => node.label)).toEqual(['start']);
    expect(graph?.outgoing.map((node) => node.label)).toEqual(['log', 'save']);
    expect(graph?.outgoing.every((node) => node.relation === 'call')).toBe(true);
  });

  it('has nothing to center on for a file', () => {
    expect(computeMiniGraph(SNAPSHOT, 'src/service.ts', 'functions')).toBeNull();
  });
});
