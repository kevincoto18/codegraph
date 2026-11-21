import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode, GraphSnapshot, RelPath } from '../../shared';
import type { LinkDelta } from './incrementalLinker';
import { IncrementalLinker } from './incrementalLinker';
import { linkGraph } from './linker';
import { parseSource } from './parser';
import type { ParsedFile } from './types';

/** Paths the random workspaces are built from (index files and JS included). */
const PATH_POOL: readonly RelPath[] = [
  'src/a.ts',
  'src/b.ts',
  'src/c/index.ts',
  'src/c/d.ts',
  'src/g.tsx',
  'lib/e.js',
  'lib/f.js',
  'src/h.ts',
];

/** Function names shared by every generated file, so imports often resolve. */
const NAMES: readonly string[] = ['alpha', 'beta', 'gamma'];

/**
 * Small deterministic PRNG (mulberry32).
 *
 * @param seed - Initial state.
 * @returns A function returning floats in [0, 1).
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks a random element.
 *
 * @param random - PRNG.
 * @param items - Non-empty list.
 * @returns One of the items.
 */
function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error('Cannot pick from an empty list.');
  }
  return item;
}

/**
 * Writes the relative specifier a file would use to import another one.
 *
 * @param from - Importing file.
 * @param to - Imported file.
 * @returns A specifier such as `./b`, `../c` (index) or `./e.js`.
 */
function specifierFor(from: RelPath, to: RelPath): string {
  let target = to;
  if (target.endsWith('/index.ts')) {
    target = posix.dirname(target);
  } else if (/\.tsx?$/.test(target)) {
    target = target.replace(/\.tsx?$/, '');
  }
  const relative = posix.relative(posix.dirname(from), target);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Generates random source code with imports, exports, classes and calls.
 *
 * @param filePath - Path of the generated file.
 * @param random - PRNG.
 * @returns Source text.
 */
function generateSource(filePath: RelPath, random: () => number): string {
  const lines: string[] = [];
  const callables: string[] = [];
  const importCount = Math.floor(random() * 4);
  for (let i = 0; i < importCount; i += 1) {
    const spec = specifierFor(filePath, pick(random, PATH_POOL));
    const form = Math.floor(random() * 4);
    if (form === 0) {
      lines.push(`import { ${pick(random, NAMES)} as imp${String(i)} } from '${spec}';`);
      callables.push(`imp${String(i)}()`);
    } else if (form === 1) {
      lines.push(`import * as ns${String(i)} from '${spec}';`);
      callables.push(`ns${String(i)}.${pick(random, NAMES)}()`);
    } else if (form === 2) {
      lines.push(`import def${String(i)} from '${spec}';`);
      callables.push(`def${String(i)}()`);
    } else {
      lines.push(`import { Box as Box${String(i)} } from '${spec}';`);
      callables.push(`Box${String(i)}.make()`);
    }
  }
  const declared = NAMES.filter(() => random() < 0.7);
  callables.push(...declared.map((name) => `${name}()`));
  for (const name of declared) {
    const calls = callables.filter(() => random() < 0.4).map((call) => `  ${call};`);
    const exported = random() < 0.8 ? 'export ' : '';
    lines.push(`${exported}function ${name}(): void {`, ...calls, '}');
  }
  if (random() < 0.5) {
    lines.push(
      'export class Box {',
      '  static make(): void {}',
      `  run(): void { this.stop(); ${callables.length > 0 ? pick(random, callables) : ''}; }`,
      '  stop(): void {}',
      '}',
    );
  }
  if (declared.length > 0 && random() < 0.5) {
    lines.push(`export default ${pick(random, declared)};`);
  }
  return lines.join('\n');
}

/**
 * Applies a delta to a snapshot (order-insensitive comparison helper).
 *
 * @param snapshot - Snapshot before the change.
 * @param delta - Changes.
 * @returns Nodes and edges by id after the change.
 */
function applyDelta(
  snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'>,
  delta: LinkDelta,
): { nodes: Map<string, GraphNode>; edges: Map<string, GraphEdge> } {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  delta.removeNodeIds.forEach((id) => nodes.delete(id));
  delta.removeEdgeIds.forEach((id) => edges.delete(id));
  delta.upsertNodes.forEach((node) => nodes.set(node.id, node));
  delta.upsertEdges.forEach((edge) => edges.set(edge.id, edge));
  return { nodes, edges };
}

/**
 * Indexes a snapshot by id.
 *
 * @param snapshot - Snapshot to index.
 * @returns Nodes and edges by id.
 */
function byId(snapshot: GraphSnapshot): {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
} {
  return applyDelta(snapshot, {
    upsertNodes: [],
    removeNodeIds: [],
    upsertEdges: [],
    removeEdgeIds: [],
  });
}

describe('IncrementalLinker', () => {
  it('matches linkGraph after every random change', () => {
    let callEdges = 0;
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = createRandom(seed);
      const linker = new IncrementalLinker();
      const files = new Map<RelPath, ParsedFile>();
      let previous = linker.snapshot(0);

      for (let step = 1; step <= 40; step += 1) {
        const upserts: ParsedFile[] = [];
        const removals: RelPath[] = [];
        const changeCount = 1 + Math.floor(random() * 3);
        for (let i = 0; i < changeCount; i += 1) {
          const filePath = pick(random, PATH_POOL);
          if (files.has(filePath) && random() < 0.3) {
            removals.push(filePath);
            files.delete(filePath);
          } else {
            const parsed = parseSource(filePath, generateSource(filePath, random));
            upserts.push(parsed);
            files.set(filePath, parsed);
          }
        }
        // Only the last change of each path counts within a batch.
        const finalUpserts = [
          ...new Map(upserts.map((file) => [file.filePath, file])).values(),
        ].filter((file) => files.get(file.filePath) === file);
        const delta = linker.apply({
          upserts: finalUpserts,
          removals: removals.filter((filePath) => !files.has(filePath)),
        });
        const actual = linker.snapshot(step);
        const expected = linkGraph(files.values(), step);
        expect(actual, `seed ${String(seed)} step ${String(step)}`).toEqual(expected);
        expect(applyDelta(previous, delta)).toEqual(byId(expected));
        callEdges += expected.edges.filter((edge) => edge.kind === 'call').length;
        previous = actual;
      }
    }
    // Guard against a generator that stops producing resolvable calls.
    expect(callEdges).toBeGreaterThan(500);
  });

  it('re-links importers when an imported file appears and disappears', () => {
    const linker = new IncrementalLinker();
    const main = parseSource(
      'src/main.ts',
      "import { run } from './run';\nfunction go() { run(); }",
    );
    linker.apply({ upserts: [main], removals: [] });
    expect(linker.snapshot(1).edges).toEqual([]);

    const run = parseSource('src/run.ts', 'export function run() {}');
    const added = linker.apply({ upserts: [run], removals: [] });
    expect(added.upsertEdges.map((edge) => edge.id).sort()).toEqual([
      'call:src/main.ts#go->src/run.ts#run',
      'import:src/main.ts->src/run.ts',
    ]);

    const removed = linker.apply({ upserts: [], removals: ['src/run.ts'] });
    expect([...removed.removeNodeIds].sort()).toEqual(['src/run.ts', 'src/run.ts#run']);
    expect([...removed.removeEdgeIds].sort()).toEqual([
      'call:src/main.ts#go->src/run.ts#run',
      'import:src/main.ts->src/run.ts',
    ]);
    expect(linker.has('src/run.ts')).toBe(false);
  });

  it('reports nothing for an unchanged re-upsert and ignores unknown removals', () => {
    const linker = new IncrementalLinker();
    const file = parseSource('a.ts', 'export function a() {}');
    linker.apply({ upserts: [file], removals: [] });
    const delta = linker.apply({ upserts: [file], removals: ['missing.ts'] });
    expect(delta).toEqual({
      upsertNodes: [],
      removeNodeIds: [],
      upsertEdges: [],
      removeEdgeIds: [],
    });
    expect(linker.size).toBe(1);
    expect(linker.getFilePaths()).toEqual(['a.ts']);
  });

  it('clears every file', () => {
    const linker = new IncrementalLinker();
    linker.apply({ upserts: [parseSource('a.ts', 'function a() {}')], removals: [] });
    linker.clear();
    expect(linker.snapshot(3)).toEqual({ version: 3, nodes: [], edges: [] });
  });
});
