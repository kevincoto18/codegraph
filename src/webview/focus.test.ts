import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowNode } from './flowTypes';
import type { FocusOptions } from './focus';
import { computeFocus, getFocusFitIds, getFocusIdsToReveal, getFocusedDisplayIds } from './focus';
import { buildFolderTree } from './folders';
import { callEdge, fileNode, functionNode } from './testFixtures';

/** `a#run → b#save → c#write`, `d#log → a#run`, plus an import `a → b`. */
const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    fileNode('src/a.ts', ['src/a.ts#run']),
    functionNode('src/a.ts', 'run'),
    fileNode('src/b.ts', ['src/b.ts#save']),
    functionNode('src/b.ts', 'save'),
    fileNode('lib/c.ts', ['lib/c.ts#write']),
    functionNode('lib/c.ts', 'write'),
    fileNode('lib/d.ts', ['lib/d.ts#log']),
    functionNode('lib/d.ts', 'log'),
  ],
  edges: [
    callEdge('src/a.ts#run', 'src/b.ts#save'),
    callEdge('src/b.ts#save', 'lib/c.ts#write'),
    callEdge('lib/d.ts#log', 'src/a.ts#run'),
    { id: 'import:src/a.ts->src/b.ts', kind: 'import', source: 'src/a.ts', target: 'src/b.ts' },
  ],
};

/** Calls only, both directions, one hop. */
const OPTIONS: FocusOptions = { depth: 1, direction: 'both', imports: false, calls: true };

describe('computeFocus', () => {
  it('finds direct neighbors in both directions, with their files', () => {
    expect([...computeFocus(SNAPSHOT, 'src/b.ts#save', OPTIONS).nodeIds].sort()).toEqual([
      'lib/c.ts',
      'lib/c.ts#write',
      'src/a.ts',
      'src/a.ts#run',
      'src/b.ts',
      'src/b.ts#save',
    ]);
  });

  it('follows one direction and more hops', () => {
    const outgoing = computeFocus(SNAPSHOT, 'lib/d.ts#log', {
      ...OPTIONS,
      depth: 2,
      direction: 'outgoing',
    });
    expect(outgoing.nodeIds.has('src/b.ts#save')).toBe(true);
    expect(outgoing.nodeIds.has('lib/c.ts#write')).toBe(false);
    const incoming = computeFocus(SNAPSHOT, 'src/b.ts#save', { ...OPTIONS, direction: 'incoming' });
    expect(incoming.nodeIds.has('src/a.ts#run')).toBe(true);
    expect(incoming.nodeIds.has('lib/c.ts#write')).toBe(false);
  });

  it('focuses a file through its functions and follows imports when enabled', () => {
    const viaCalls = computeFocus(SNAPSHOT, 'src/a.ts', OPTIONS);
    expect(viaCalls.nodeIds.has('src/b.ts#save')).toBe(true);
    expect(viaCalls.nodeIds.has('lib/d.ts#log')).toBe(true);
    const importsOnly = computeFocus(SNAPSHOT, 'src/a.ts', {
      ...OPTIONS,
      imports: true,
      calls: false,
    });
    expect([...importsOnly.nodeIds].sort()).toEqual(['src/a.ts', 'src/a.ts#run', 'src/b.ts']);
  });

  it('is empty for unknown nodes', () => {
    expect(computeFocus(SNAPSHOT, 'missing.ts', OPTIONS).nodeIds.size).toBe(0);
  });
});

describe('displaying a focus', () => {
  const tree = buildFolderTree(SNAPSHOT.nodes);
  const focus = computeFocus(SNAPSHOT, 'src/b.ts#save', OPTIONS);

  it('highlights collapsed files and folders that contain focused nodes', () => {
    const nodes: CodeGraphFlowNode[] = [
      {
        id: 'folder:src',
        type: 'folder',
        position: { x: 0, y: 0 },
        data: {
          label: 'src',
          path: 'src',
          fileCount: 2,
          collapsed: true,
          isWorkspaceRoot: false,
          languages: [],
          tooltip: 'src',
        },
      },
      {
        id: 'folder:lib',
        type: 'folder',
        position: { x: 0, y: 0 },
        data: {
          label: 'lib',
          path: 'lib',
          fileCount: 2,
          collapsed: false,
          isWorkspaceRoot: false,
          languages: [],
          tooltip: 'lib',
        },
      },
      {
        id: 'lib/c.ts',
        type: 'file',
        parentId: 'folder:lib',
        position: { x: 0, y: 0 },
        data: {
          label: 'c.ts',
          filePath: 'lib/c.ts',
          line: 1,
          functionCount: 1,
          collapsed: true,
          tooltip: 'lib/c.ts',
        },
      },
      {
        id: 'lib/d.ts',
        type: 'file',
        parentId: 'folder:lib',
        position: { x: 0, y: 0 },
        data: {
          label: 'd.ts',
          filePath: 'lib/d.ts',
          line: 1,
          functionCount: 1,
          collapsed: true,
          tooltip: 'lib/d.ts',
        },
      },
    ];
    expect([...getFocusedDisplayIds(nodes, focus, tree)].sort()).toEqual([
      'folder:lib',
      'folder:src',
      'lib/c.ts',
    ]);
  });

  it('reveals the focused function and the folders of its neighbors', () => {
    expect([...getFocusIdsToReveal(SNAPSHOT, focus, tree)].sort()).toEqual([
      'folder:lib',
      'folder:src',
      'src/b.ts',
    ]);
    expect([...getFocusIdsToReveal(SNAPSHOT, focus, null)]).toEqual(['src/b.ts']);
  });
});

describe('getFocusFitIds', () => {
  it('frames functions, not the whole files that contain them', () => {
    const focus = computeFocus(SNAPSHOT, 'src/b.ts#save', OPTIONS);
    expect(getFocusFitIds(SNAPSHOT, focus).sort()).toEqual([
      'lib/c.ts#write',
      'src/a.ts#run',
      'src/b.ts#save',
    ]);
  });

  it('keeps a focused file and the files it imports', () => {
    const focus = computeFocus(SNAPSHOT, 'src/a.ts', { ...OPTIONS, imports: true, calls: false });
    expect(getFocusFitIds(SNAPSHOT, focus).sort()).toEqual([
      'src/a.ts',
      'src/a.ts#run',
      'src/b.ts',
    ]);
  });
});
