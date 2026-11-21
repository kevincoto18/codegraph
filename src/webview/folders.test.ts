import { describe, expect, it } from 'vitest';

import {
  buildFolderTree,
  createFolderId,
  getAllFolderIds,
  getAncestorFolderIds,
  isFolderId,
  isFolderViewEnabled,
} from './folders';
import { fileNode, functionNode } from './testFixtures';

/** Files at several depths, with a chain of folders that only hold one folder. */
const NODES = [
  fileNode('README.ts'),
  fileNode('src/extension/analyzer/parser.ts', ['src/extension/analyzer/parser.ts#parse']),
  functionNode('src/extension/analyzer/parser.ts', 'parse'),
  fileNode('src/extension/analyzer/linker.ts'),
  fileNode('src/extension/cache.ts'),
  fileNode('src/webview/App.tsx'),
  fileNode('lib/a/b/c/util.js'),
];

describe('buildFolderTree', () => {
  const tree = buildFolderTree(NODES);

  it('builds nested folders and compacts chains without files', () => {
    expect(tree.rootFolderIds).toEqual(['folder:lib/a/b/c', 'folder:src']);
    expect(tree.rootFileIds).toEqual(['README.ts']);
    expect(tree.folders.get('folder:lib/a/b/c')?.label).toBe('lib/a/b/c');
    expect(tree.folders.get('folder:src')).toMatchObject({
      label: 'src',
      parentId: null,
      folderIds: ['folder:src/extension', 'folder:src/webview'],
      fileIds: [],
      fileCount: 4,
    });
    expect(tree.folders.get('folder:src/extension')).toMatchObject({
      label: 'extension',
      parentId: 'folder:src',
      folderIds: ['folder:src/extension/analyzer'],
      fileIds: ['src/extension/cache.ts'],
      fileCount: 3,
    });
    expect(tree.folders.get('folder:src/extension/analyzer')?.fileIds).toEqual([
      'src/extension/analyzer/parser.ts',
      'src/extension/analyzer/linker.ts',
    ]);
  });

  it('maps files to their folder and lists ancestors innermost first', () => {
    expect(tree.folderOfFile.get('src/webview/App.tsx')).toBe('folder:src/webview');
    expect(tree.folderOfFile.has('README.ts')).toBe(false);
    expect(getAncestorFolderIds(tree, 'src/extension/analyzer/parser.ts')).toEqual([
      'folder:src/extension/analyzer',
      'folder:src/extension',
      'folder:src',
    ]);
    expect(getAncestorFolderIds(tree, 'README.ts')).toEqual([]);
    expect(getAllFolderIds(tree).size).toBe(5);
  });

  it('handles an empty graph', () => {
    const empty = buildFolderTree([]);
    expect(empty.rootFolderIds).toEqual([]);
    expect(empty.rootFileIds).toEqual([]);
  });
});

describe('folder ids and view mode', () => {
  it('prefixes folder ids', () => {
    expect(createFolderId('src/a')).toBe('folder:src/a');
    expect(isFolderId('folder:src/a')).toBe(true);
    expect(isFolderId('src/a.ts')).toBe(false);
  });

  it('enables the folder view by mode and size', () => {
    expect(isFolderViewEnabled('always', 1)).toBe(true);
    expect(isFolderViewEnabled('never', 10_000)).toBe(false);
    expect(isFolderViewEnabled('auto', 300)).toBe(false);
    expect(isFolderViewEnabled('auto', 301)).toBe(true);
    expect(isFolderViewEnabled('auto', 5, 4)).toBe(true);
  });
});
