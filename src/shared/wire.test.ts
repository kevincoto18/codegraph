import { describe, expect, it } from 'vitest';

import { createGraphInitMessages } from './messages';
import type { GraphSnapshot } from './types';
import { decodeSnapshot, encodeSnapshot } from './wire';

/** Snapshot covering repeated names, a custom id, a custom label and edges without line. */
const SNAPSHOT: GraphSnapshot = {
  version: 7,
  nodes: [
    {
      id: 'src/a.ts',
      kind: 'file',
      label: 'a.ts',
      filePath: 'src/a.ts',
      line: 1,
      functionIds: ['src/a.ts#run', 'src/a.ts#run~2', 'custom-id'],
    },
    {
      id: 'src/a.ts#run',
      kind: 'function',
      label: 'run',
      filePath: 'src/a.ts',
      line: 2,
      fileId: 'src/a.ts',
      qualifiedName: 'run',
      functionKind: 'function',
      endLine: 4,
      exported: true,
    },
    {
      id: 'src/a.ts#run~2',
      kind: 'function',
      label: 'run',
      filePath: 'src/a.ts',
      line: 5,
      fileId: 'src/a.ts',
      qualifiedName: 'run',
      functionKind: 'arrow',
      endLine: 5,
      exported: false,
    },
    {
      id: 'custom-id',
      kind: 'function',
      label: 'Box.open',
      filePath: 'src/a.ts',
      line: 9,
      fileId: 'src/a.ts',
      qualifiedName: 'Box.open',
      functionKind: 'method',
      endLine: 12,
      exported: false,
    },
    {
      id: 'b.js',
      kind: 'file',
      label: 'B (root)',
      filePath: 'b.js',
      line: 1,
      functionIds: [],
    },
  ],
  edges: [
    { id: 'import:src/a.ts->b.js', kind: 'import', source: 'src/a.ts', target: 'b.js', line: 1 },
    {
      id: 'call:src/a.ts#run->custom-id',
      kind: 'call',
      source: 'src/a.ts#run',
      target: 'custom-id',
      line: 3,
    },
    {
      id: 'call:custom-id->src/a.ts#run~2',
      kind: 'call',
      source: 'custom-id',
      target: 'src/a.ts#run~2',
    },
  ],
};

describe('wire format', () => {
  it('round-trips a snapshot in one chunk', () => {
    const chunks = encodeSnapshot(SNAPSHOT);
    expect(chunks).toHaveLength(1);
    expect(decodeSnapshot(7, chunks)).toEqual(SNAPSHOT);
  });

  it('only sends ids and labels that cannot be derived', () => {
    const [chunk] = encodeSnapshot(SNAPSHOT);
    expect(chunk?.files).toEqual([
      [
        'src/a.ts',
        [
          ['run', 0, 2, 4, 1],
          ['run', 1, 5, 5, 0],
          ['Box.open', 2, 9, 12, 0, 'custom-id'],
        ],
      ],
      ['b.js', [], 'B (root)'],
    ]);
    expect(chunk?.edges).toEqual([0, 0, 4, 1, 1, 1, 3, 3, 1, 3, 2, 0]);
  });

  it('splits large graphs into chunks and reassembles them', () => {
    const chunks = encodeSnapshot(SNAPSHOT, { maxNodes: 1, maxEdges: 1 });
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.files.length)).toEqual([1, 1, 0]);
    expect(chunks.map((chunk) => chunk.edges.length)).toEqual([4, 4, 4]);
    expect(decodeSnapshot(7, chunks)).toEqual(SNAPSHOT);
  });

  it('drops dangling edges', () => {
    const dangling: GraphSnapshot = {
      ...SNAPSHOT,
      edges: [{ id: 'import:src/a.ts->x', kind: 'import', source: 'src/a.ts', target: 'x' }],
    };
    expect(decodeSnapshot(7, encodeSnapshot(dangling)).edges).toEqual([]);
  });

  it('is much smaller than the plain snapshot', () => {
    const plain = JSON.stringify(SNAPSHOT).length;
    const wire = JSON.stringify(encodeSnapshot(SNAPSHOT)).length;
    expect(wire).toBeLessThan(plain / 2);
  });
});

describe('createGraphInitMessages', () => {
  it('numbers the parts and flags the last one', () => {
    const messages = createGraphInitMessages(SNAPSHOT, { maxNodes: 1, maxEdges: 1 });
    expect(messages.map((m) => [m.version, m.index, m.last])).toEqual([
      [7, 0, false],
      [7, 1, false],
      [7, 2, true],
    ]);
  });

  it('sends an empty graph as a single message', () => {
    const messages = createGraphInitMessages({ version: 1, nodes: [], edges: [] });
    expect(messages).toEqual([
      { type: 'graph/init', version: 1, index: 0, last: true, chunk: { files: [], edges: [] } },
    ]);
  });
});
