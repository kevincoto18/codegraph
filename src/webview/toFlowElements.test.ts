import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import {
  FILE_HEADER_HEIGHT,
  FILE_NODE_WIDTH,
  FILE_PADDING,
  FUNCTION_ROW_GAP,
  FUNCTION_ROW_HEIGHT,
  FOLDER_HEADER_HEIGHT,
  getFileNodeHeight,
  toFlowElements,
} from './toFlowElements';
import { assignFolderColors } from './folderColors';
import { buildFolderTree } from './folders';

/** Two files: `a.ts` (2 functions) calls into `b.ts` (1 function). */
const SNAPSHOT: GraphSnapshot = {
  version: 1,
  nodes: [
    {
      id: 'src/a.ts',
      kind: 'file',
      label: 'a.ts',
      filePath: 'src/a.ts',
      line: 1,
      functionIds: ['src/a.ts#run', 'src/a.ts#Svc.go'],
    },
    {
      id: 'src/a.ts#run',
      kind: 'function',
      label: 'run',
      filePath: 'src/a.ts',
      line: 3,
      fileId: 'src/a.ts',
      qualifiedName: 'run',
      functionKind: 'function',
      endLine: 5,
      exported: true,
    },
    {
      id: 'src/a.ts#Svc.go',
      kind: 'function',
      label: 'Svc.go',
      filePath: 'src/a.ts',
      line: 8,
      fileId: 'src/a.ts',
      qualifiedName: 'Svc.go',
      functionKind: 'method',
      endLine: 9,
      exported: false,
    },
    {
      id: 'src/b.ts',
      kind: 'file',
      label: 'b.ts',
      filePath: 'src/b.ts',
      line: 1,
      functionIds: ['src/b.ts#help'],
    },
    {
      id: 'src/b.ts#help',
      kind: 'function',
      label: 'help',
      filePath: 'src/b.ts',
      line: 1,
      fileId: 'src/b.ts',
      qualifiedName: 'help',
      functionKind: 'arrow',
      endLine: 1,
      exported: true,
    },
  ],
  edges: [
    {
      id: 'import:src/a.ts->src/b.ts',
      kind: 'import',
      source: 'src/a.ts',
      target: 'src/b.ts',
      line: 1,
    },
    {
      id: 'call:src/a.ts#run->src/b.ts#help',
      kind: 'call',
      source: 'src/a.ts#run',
      target: 'src/b.ts#help',
      line: 4,
    },
    { id: 'call:src/a.ts#run->gone', kind: 'call', source: 'src/a.ts#run', target: 'gone' },
  ],
};

describe('getFileNodeHeight', () => {
  it('fits the header, rows with gaps and bottom padding', () => {
    expect(getFileNodeHeight(0)).toBe(FILE_HEADER_HEIGHT + FILE_PADDING);
    expect(getFileNodeHeight(1)).toBe(FILE_HEADER_HEIGHT + FUNCTION_ROW_HEIGHT + FILE_PADDING);
    expect(getFileNodeHeight(3)).toBe(
      FILE_HEADER_HEIGHT + 3 * FUNCTION_ROW_HEIGHT + 2 * FUNCTION_ROW_GAP + FILE_PADDING,
    );
  });
});

describe('toFlowElements', () => {
  const { nodes, edges } = toFlowElements(SNAPSHOT);

  it('emits each file followed by its functions', () => {
    expect(nodes.map((node) => node.id)).toEqual([
      'src/a.ts',
      'src/a.ts#run',
      'src/a.ts#Svc.go',
      'src/b.ts',
      'src/b.ts#help',
    ]);
  });

  it('sizes file containers and carries navigation data', () => {
    expect(nodes[0]).toEqual({
      id: 'src/a.ts',
      type: 'file',
      position: { x: 0, y: 0 },
      width: FILE_NODE_WIDTH,
      height: getFileNodeHeight(2),
      style: { '--cg-folder-color': assignFolderColors(['src/a.ts', 'src/b.ts']).get('src') },
      data: { label: 'a.ts', filePath: 'src/a.ts', line: 1, functionCount: 2, collapsed: false },
    });
  });

  it('stacks functions inside their file, not draggable on their own', () => {
    expect(nodes[2]).toEqual({
      id: 'src/a.ts#Svc.go',
      type: 'function',
      parentId: 'src/a.ts',
      extent: 'parent',
      draggable: false,
      position: { x: FILE_PADDING, y: FILE_HEADER_HEIGHT + FUNCTION_ROW_HEIGHT + FUNCTION_ROW_GAP },
      width: FILE_NODE_WIDTH - 2 * FILE_PADDING,
      height: FUNCTION_ROW_HEIGHT,
      data: {
        label: 'Svc.go',
        filePath: 'src/a.ts',
        line: 8,
        functionKind: 'method',
        exported: false,
      },
    });
  });

  it('styles edges by kind and drops edges to unknown nodes', () => {
    expect(edges.map((edge) => [edge.id, edge.className])).toEqual([
      ['import:src/a.ts->src/b.ts', 'cg-edge cg-edge--import'],
      ['call:src/a.ts#run->src/b.ts#help', 'cg-edge cg-edge--call'],
    ]);
    expect(edges[1]).toMatchObject({
      source: 'src/a.ts#run',
      target: 'src/b.ts#help',
      markerEnd: { type: 'arrowclosed' },
      data: { kind: 'call', count: 1 },
    });
  });

  it('skips function ids that have no function node', () => {
    const snapshot: GraphSnapshot = {
      version: 1,
      nodes: [
        {
          id: 'x.ts',
          kind: 'file',
          label: 'x.ts',
          filePath: 'x.ts',
          line: 1,
          functionIds: ['x.ts#missing'],
        },
      ],
      edges: [],
    };
    const result = toFlowElements(snapshot);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.data).toMatchObject({ functionCount: 0 });
  });
});

describe('toFlowElements — collapsed files', () => {
  const { nodes, edges } = toFlowElements(SNAPSHOT, new Set(['src/a.ts']));

  it('renders only the header of collapsed files and hides their functions', () => {
    expect(nodes.map((node) => node.id)).toEqual(['src/a.ts', 'src/b.ts', 'src/b.ts#help']);
    expect(nodes[0]).toMatchObject({
      height: FILE_HEADER_HEIGHT,
      data: { collapsed: true, functionCount: 2 },
    });
  });

  it('re-routes calls of hidden functions to their file', () => {
    expect(edges.map((edge) => [edge.id, edge.source, edge.target])).toEqual([
      ['import:src/a.ts->src/b.ts', 'src/a.ts', 'src/b.ts'],
      ['call:src/a.ts->src/b.ts#help', 'src/a.ts', 'src/b.ts#help'],
    ]);
  });

  it('labels merged edges with their count', () => {
    const snapshot: GraphSnapshot = {
      ...SNAPSHOT,
      edges: [
        {
          id: 'call:src/a.ts#run->src/b.ts#help',
          kind: 'call',
          source: 'src/a.ts#run',
          target: 'src/b.ts#help',
        },
        {
          id: 'call:src/a.ts#Svc.go->src/b.ts#help',
          kind: 'call',
          source: 'src/a.ts#Svc.go',
          target: 'src/b.ts#help',
        },
      ],
    };
    const [merged] = toFlowElements(snapshot, new Set(['src/a.ts'])).edges;
    expect(merged).toMatchObject({ label: '×2', data: { kind: 'call', count: 2 } });
    expect(toFlowElements(snapshot).edges[0]).not.toHaveProperty('label');
  });
});

describe('toFlowElements — folders', () => {
  const tree = buildFolderTree(SNAPSHOT.nodes);

  it('nests files in their folder, parents first', () => {
    const { nodes } = toFlowElements(SNAPSHOT, new Set(), tree);
    expect(nodes[0]).toMatchObject({
      id: 'folder:src',
      type: 'folder',
      data: { label: 'src', path: 'src', fileCount: 2, collapsed: false },
    });
    const files = nodes.filter((node) => node.type === 'file');
    expect(files.every((node) => node.parentId === 'folder:src' && node.extent === 'parent')).toBe(
      true,
    );
  });

  it('hides the content of collapsed folders and routes their edges to the folder', () => {
    const { nodes, edges } = toFlowElements(SNAPSHOT, new Set(['folder:src']), tree);
    expect(nodes.map((node) => node.id)).toEqual(['folder:src']);
    expect(nodes[0]?.height).toBe(FOLDER_HEADER_HEIGHT);
    expect(edges).toEqual([]);
  });
});
