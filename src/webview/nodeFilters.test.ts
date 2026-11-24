import { describe, expect, it } from 'vitest';

import type { FileGraphNode, FunctionGraphNode, GraphSnapshot, NodeFilters } from '../shared';
import {
  applyNodeFilters,
  compileExcludePattern,
  countActiveNodeFilters,
  folderHiddenState,
  isTestFile,
  listFolders,
  toggleHiddenFolder,
} from './nodeFilters';

/** Filters that hide nothing. */
const NONE: NodeFilters = {
  hideTests: false,
  exportedOnly: false,
  hiddenFolders: [],
  excludePatterns: [],
};

/**
 * Builds a file node.
 *
 * @param path - File path (also its id).
 * @param functionIds - Ids of its functions.
 * @returns The node.
 */
function file(path: string, functionIds: string[] = []): FileGraphNode {
  return { id: path, kind: 'file', label: path, filePath: path, line: 1, functionIds };
}

/**
 * Builds a function node.
 *
 * @param path - File path.
 * @param name - Function name.
 * @param exported - Whether it is exported.
 * @returns The node.
 */
function fn(path: string, name: string, exported: boolean): FunctionGraphNode {
  return {
    id: `${path}#${name}`,
    kind: 'function',
    label: name,
    filePath: path,
    line: 2,
    fileId: path,
    qualifiedName: name,
    functionKind: 'function',
    endLine: 3,
    exported,
  };
}

const SNAPSHOT: GraphSnapshot = {
  version: 4,
  nodes: [
    file('src/a.ts', ['src/a.ts#run', 'src/a.ts#helper']),
    fn('src/a.ts', 'run', true),
    fn('src/a.ts', 'helper', false),
    file('src/a.test.ts', ['src/a.test.ts#spec']),
    fn('src/a.test.ts', 'spec', false),
    file('src/legacy/old.ts', ['src/legacy/old.ts#old']),
    fn('src/legacy/old.ts', 'old', true),
  ],
  edges: [
    { id: 'e1', kind: 'call', source: 'src/a.ts#run', target: 'src/a.ts#helper' },
    { id: 'e2', kind: 'call', source: 'src/a.test.ts#spec', target: 'src/a.ts#run' },
    { id: 'e3', kind: 'call', source: 'src/a.ts#run', target: 'src/legacy/old.ts#old' },
    { id: 'e4', kind: 'import', source: 'src/a.test.ts', target: 'src/a.ts' },
  ],
};

/**
 * Ids of the nodes of a snapshot.
 *
 * @param snapshot - Graph.
 * @returns The ids, in order.
 */
function ids(snapshot: GraphSnapshot): string[] {
  return snapshot.nodes.map((node) => node.id);
}

describe('isTestFile', () => {
  it.each([
    'src/a.test.ts',
    'src/a.spec.jsx',
    'app/test_user.py',
    'app/user_test.py',
    'conftest.py',
    'src/__tests__/a.ts',
    'tests/helpers.py',
  ])('detects %s', (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each(['src/a.ts', 'src/testing.ts', 'src/latest.ts', 'app/contest.py'])(
    'ignores %s',
    (path) => {
      expect(isTestFile(path)).toBe(false);
    },
  );
});

describe('compileExcludePattern', () => {
  it('matches names at any depth when the pattern has no slash', () => {
    const pattern = compileExcludePattern('*.gen.ts');
    expect(pattern?.test('a.gen.ts')).toBe(true);
    expect(pattern?.test('src/deep/b.gen.ts')).toBe(true);
    expect(pattern?.test('src/b.ts')).toBe(false);
    expect(compileExcludePattern('generated')?.test('src/generated/x.ts')).toBe(true);
  });

  it('anchors patterns with a slash at the workspace root', () => {
    const pattern = compileExcludePattern('src/legacy/');
    expect(pattern?.test('src/legacy/old.ts')).toBe(true);
    expect(pattern?.test('lib/src/legacy/old.ts')).toBe(false);
    expect(compileExcludePattern('**/fixtures/**')?.test('a/b/fixtures/c/d.ts')).toBe(true);
    expect(compileExcludePattern('src/*.{js,jsx}')?.test('src/a.jsx')).toBe(true);
    expect(compileExcludePattern('src/*.{js,jsx}')?.test('src/a.ts')).toBe(false);
  });

  it('ignores blank patterns', () => {
    expect(compileExcludePattern('  ')).toBeNull();
  });
});

describe('applyNodeFilters', () => {
  it('returns the same graph when nothing is filtered', () => {
    const result = applyNodeFilters(SNAPSHOT, NONE);
    expect(result.snapshot).toBe(SNAPSHOT);
    expect(result.hiddenFiles).toBe(0);
  });

  it('hides test files with their functions and edges', () => {
    const result = applyNodeFilters(SNAPSHOT, { ...NONE, hideTests: true });
    expect(ids(result.snapshot)).not.toContain('src/a.test.ts');
    expect(ids(result.snapshot)).not.toContain('src/a.test.ts#spec');
    expect(result.snapshot.edges.map((edge) => edge.id)).toEqual(['e1', 'e3']);
    expect(result).toMatchObject({ hiddenFiles: 1, hiddenFunctions: 1 });
    expect(result.snapshot.version).toBe(4);
  });

  it('keeps only exported functions and updates their files', () => {
    const result = applyNodeFilters(SNAPSHOT, { ...NONE, exportedOnly: true });
    const a = result.snapshot.nodes.find((node) => node.id === 'src/a.ts');
    expect(a?.kind === 'file' ? a.functionIds : null).toEqual(['src/a.ts#run']);
    expect(ids(result.snapshot)).toContain('src/a.test.ts');
    expect(result.snapshot.edges.map((edge) => edge.id)).toEqual(['e3', 'e4']);
    expect(result).toMatchObject({ hiddenFiles: 0, hiddenFunctions: 2 });
  });

  it('hides folders and patterns', () => {
    expect(
      ids(applyNodeFilters(SNAPSHOT, { ...NONE, hiddenFolders: ['src/legacy'] }).snapshot),
    ).not.toContain('src/legacy/old.ts');
    expect(
      ids(applyNodeFilters(SNAPSHOT, { ...NONE, excludePatterns: ['*.test.*'] }).snapshot),
    ).not.toContain('src/a.test.ts');
  });

  it('returns the same graph when the filters match nothing', () => {
    expect(applyNodeFilters(SNAPSHOT, { ...NONE, hiddenFolders: ['docs'] }).snapshot).toBe(
      SNAPSHOT,
    );
  });
});

describe('folder helpers', () => {
  it('lists folders with recursive counts, parents first', () => {
    expect(listFolders(['src/a.ts', 'src/legacy/old.ts', 'README.md'])).toEqual([
      { path: 'src', name: 'src', depth: 0, fileCount: 2 },
      { path: 'src/legacy', name: 'legacy', depth: 1, fileCount: 1 },
    ]);
  });

  it('toggles hidden folders and drops redundant subfolders', () => {
    expect(toggleHiddenFolder(['src/legacy'], 'src')).toEqual(['src']);
    expect(toggleHiddenFolder(['src'], 'src')).toEqual([]);
    expect(folderHiddenState(['src'], 'src/legacy')).toBe('parent');
    expect(folderHiddenState(['src'], 'src')).toBe('self');
    expect(folderHiddenState(['src'], 'lib')).toBeNull();
  });

  it('counts active filters', () => {
    expect(countActiveNodeFilters(NONE)).toBe(0);
    expect(countActiveNodeFilters({ ...NONE, hideTests: true, hiddenFolders: ['a', 'b'] })).toBe(3);
  });
});
