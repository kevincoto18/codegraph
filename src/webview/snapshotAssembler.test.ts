import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../shared';
import { createGraphInitMessages } from '../shared';
import { SnapshotAssembler } from './snapshotAssembler';

/** Two files with an import between them. */
const SNAPSHOT: GraphSnapshot = {
  version: 3,
  nodes: [
    { id: 'a.ts', kind: 'file', label: 'a.ts', filePath: 'a.ts', line: 1, functionIds: [] },
    { id: 'b.ts', kind: 'file', label: 'b.ts', filePath: 'b.ts', line: 1, functionIds: [] },
  ],
  edges: [{ id: 'import:a.ts->b.ts', kind: 'import', source: 'a.ts', target: 'b.ts', line: 1 }],
};

/** Messages that transport {@link SNAPSHOT} in two parts. */
const MESSAGES = createGraphInitMessages(SNAPSHOT, { maxNodes: 1, maxEdges: 1 });

describe('SnapshotAssembler', () => {
  it('returns the snapshot once the last part arrives', () => {
    const assembler = new SnapshotAssembler();
    expect(MESSAGES).toHaveLength(2);
    const results = MESSAGES.map((message) => assembler.accept(message));
    expect(results.slice(0, -1)).toEqual([null]);
    expect(results.at(-1)).toEqual(SNAPSHOT);
  });

  it('discards a sequence with a missing part', () => {
    const assembler = new SnapshotAssembler();
    const [first, second] = MESSAGES;
    if (first === undefined || second === undefined) {
      throw new Error('Expected two parts.');
    }
    expect(assembler.accept({ ...second, index: 1 })).toBeNull(); // no part 0 yet
    expect(assembler.accept(first)).toBeNull();
    expect(assembler.accept({ ...second, version: 9 })).toBeNull(); // other snapshot
    expect(assembler.accept(second)).toBeNull(); // sequence was discarded
  });

  it('restarts when a new part 0 arrives', () => {
    const assembler = new SnapshotAssembler();
    const [first] = MESSAGES;
    if (first === undefined) {
      throw new Error('Expected a part.');
    }
    assembler.accept(first);
    const results = MESSAGES.map((message) => assembler.accept(message));
    expect(results.at(-1)).toEqual(SNAPSHOT);
  });
});
