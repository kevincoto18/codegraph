import { describe, expect, it } from 'vitest';

import type { FileGraphNode, GraphSnapshot } from '../../shared';
import { linkGraph } from './linker';
import { parseSource } from './parser';

/** Mini workspace covering every supported resolution path. */
const SOURCES: Readonly<Record<string, string>> = {
  'src/math.ts': [
    'export function add(): number { return 1; }',
    'export function mul(): number { return add() + add(); }',
    'function helper(): void {}',
    'export default function main(): void { helper(); main(); }',
  ].join('\n'),
  'src/store.ts': ['export class Store {', '  static create(): void {}', '}'].join('\n'),
  'src/service.ts': [
    "import { add as plus } from './math';",
    "import main from './math';",
    "import * as m from './math';",
    "import { Store } from './store';",
    "import { readFile } from 'node:fs';",
    "import './missing';",
    'export class Service {',
    '  run(): void {',
    '    plus();',
    '    main();',
    '    m.mul();',
    '    this.stop();',
    '    Store.create();',
    '    Local.build();',
    '    readFile();',
    '    unknown();',
    '    console.log();',
    '  }',
    '  stop(): void {}',
    '}',
    'class Local { static build(): void {} }',
  ].join('\n'),
  'lib/helpers.js': [
    'function main() {}',
    'function fmt() {}',
    'module.exports = main;',
    'module.exports.fmt = fmt;',
  ].join('\n'),
  'lib/cjs.js': [
    "const h = require('./helpers');",
    "const { fmt: format } = require('./helpers');",
    'function go() { h(); h.fmt(); format(); }',
  ].join('\n'),
};

/**
 * Parses and links the mini workspace.
 *
 * @param sources - File contents by path.
 * @returns The linked snapshot.
 */
function link(sources: Readonly<Record<string, string>> = SOURCES): GraphSnapshot {
  const parsed = Object.entries(sources).map(([path, content]) => parseSource(path, content));
  return linkGraph(parsed, 7);
}

/**
 * Lists `source -> target` pairs of every edge of a kind.
 *
 * @param snapshot - Linked snapshot.
 * @param kind - Edge kind to keep.
 * @returns Sorted pairs.
 */
function edgePairs(snapshot: GraphSnapshot, kind: 'import' | 'call'): string[] {
  return snapshot.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.source} -> ${edge.target}`)
    .sort();
}

describe('linkGraph — nodes', () => {
  const snapshot = link();

  it('stamps the requested version', () => {
    expect(snapshot.version).toBe(7);
  });

  it('creates one file node per file, sorted by path', () => {
    const files = snapshot.nodes.filter((node) => node.kind === 'file').map((node) => node.id);
    expect(files).toEqual([
      'lib/cjs.js',
      'lib/helpers.js',
      'src/math.ts',
      'src/service.ts',
      'src/store.ts',
    ]);
  });

  it('lists function ids inside each file node and creates the function nodes', () => {
    const service = snapshot.nodes.find((node) => node.id === 'src/service.ts') as FileGraphNode;
    expect(service).toMatchObject({ label: 'service.ts', line: 1 });
    expect(service.functionIds).toEqual([
      'src/service.ts#Service.run',
      'src/service.ts#Service.stop',
      'src/service.ts#Local.build',
    ]);
    expect(snapshot.nodes.find((node) => node.id === 'src/service.ts#Service.run')).toEqual({
      id: 'src/service.ts#Service.run',
      kind: 'function',
      label: 'Service.run',
      filePath: 'src/service.ts',
      line: 8,
      fileId: 'src/service.ts',
      qualifiedName: 'Service.run',
      functionKind: 'method',
      endLine: 18,
      exported: true,
    });
  });

  it('disambiguates functions with the same qualified name', () => {
    const dup = link({ 'a.js': 'function init() {}\nfunction init() {}' });
    const ids = dup.nodes.filter((node) => node.kind === 'function').map((node) => node.id);
    expect(ids).toEqual(['a.js#init', 'a.js#init~2']);
  });
});

describe('linkGraph — import edges', () => {
  it('links files through resolved relative imports only, deduplicated', () => {
    expect(edgePairs(link(), 'import')).toEqual([
      'lib/cjs.js -> lib/helpers.js',
      'src/service.ts -> src/math.ts',
      'src/service.ts -> src/store.ts',
    ]);
  });

  it('keeps the line of the first import of a target', () => {
    const edge = link().edges.find((e) => e.id === 'import:src/service.ts->src/math.ts');
    expect(edge?.line).toBe(1);
  });
});

describe('linkGraph — call edges', () => {
  const pairs = edgePairs(link(), 'call');

  it('resolves local, aliased, default, namespace, this, static and CommonJS calls', () => {
    expect(pairs).toEqual([
      'lib/cjs.js#go -> lib/helpers.js#fmt',
      'lib/cjs.js#go -> lib/helpers.js#main',
      'src/math.ts#main -> src/math.ts#helper',
      'src/math.ts#mul -> src/math.ts#add',
      'src/service.ts#Service.run -> src/math.ts#add',
      'src/service.ts#Service.run -> src/math.ts#main',
      'src/service.ts#Service.run -> src/math.ts#mul',
      'src/service.ts#Service.run -> src/service.ts#Local.build',
      'src/service.ts#Service.run -> src/service.ts#Service.stop',
      'src/service.ts#Service.run -> src/store.ts#Store.create',
    ]);
  });

  it('skips self-recursion and deduplicates repeated calls', () => {
    expect(pairs).not.toContain('src/math.ts#main -> src/math.ts#main');
    expect(pairs.filter((pair) => pair === 'src/math.ts#mul -> src/math.ts#add')).toHaveLength(1);
  });

  it('does not call a whole ES namespace', () => {
    const snapshot = link({
      'a.ts': "import * as b from './b';\nexport function run(): void { b(); }",
      'b.ts': 'export default function main(): void {}',
    });
    expect(edgePairs(snapshot, 'call')).toEqual([]);
  });

  it('ignores exports that are not functions', () => {
    const snapshot = link({
      'a.ts': "import { value } from './b';\nexport function run(): void { value(); }",
      'b.ts': 'export const value = 42;',
    });
    expect(edgePairs(snapshot, 'call')).toEqual([]);
  });
});

describe('linkGraph — determinism', () => {
  it('produces the same snapshot regardless of input order', () => {
    const parsed = Object.entries(SOURCES).map(([path, content]) => parseSource(path, content));
    expect(linkGraph([...parsed].reverse(), 1)).toEqual(linkGraph(parsed, 1));
  });
});
