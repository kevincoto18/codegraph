import { describe, expect, it } from 'vitest';

import {
  buildFolderTree,
  createFolderId,
  formatWorkspacePath,
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

describe('buildFolderTree in a multi-root workspace', () => {
  const nodes = [
    fileNode('web/src/app.ts'),
    fileNode('web/src/view.tsx'),
    fileNode('web/scripts/build.js'),
    fileNode('api/src/main/java/com/demo/App.java'),
    fileNode('api/src/main/java/com/demo/Repo.java'),
  ];
  const tree = buildFolderTree(nodes, ['web', 'api']);

  it('keeps workspace folders as top-level folders, in workspace order', () => {
    expect(tree.rootFolderIds).toEqual(['folder:web', 'folder:api']);
    expect(tree.workspaceRoots).toEqual(['web', 'api']);
  });

  it('never merges a workspace folder with its only sub-folder', () => {
    expect(tree.folders.get('folder:api')).toMatchObject({
      label: 'api',
      isWorkspaceRoot: true,
      workspaceRoot: 'api',
      folderIds: ['folder:api/src/main/java/com/demo'],
    });
    expect(tree.folders.get('folder:api/src/main/java/com/demo')).toMatchObject({
      label: 'src/main/java/com/demo',
      isWorkspaceRoot: false,
      workspaceRoot: 'api',
      languages: [],
    });
  });

  it('summarizes the languages of each workspace folder, most used first', () => {
    expect(tree.folders.get('folder:web')?.languages).toEqual(['TS', 'JS']);
    expect(tree.folders.get('folder:api')?.languages).toEqual(['JAVA']);
  });

  it('keeps single-folder trees unchanged', () => {
    const single = buildFolderTree(nodes, ['web']);
    expect(single.workspaceRoots).toEqual([]);
    expect(single.folders.get('folder:api/src/main/java/com/demo')?.label).toBe(
      'api/src/main/java/com/demo',
    );
    expect(single.folders.get('folder:web')?.isWorkspaceRoot).toBe(false);
  });
});

describe('formatWorkspacePath', () => {
  it('sets the workspace folder apart in a multi-root workspace', () => {
    expect(formatWorkspacePath('go-demo/internal/storage', ['go-demo', 'web'])).toBe(
      'go-demo › internal/storage',
    );
    expect(formatWorkspacePath('go-demo', ['go-demo', 'web'])).toBe('go-demo');
  });

  it('leaves paths alone with one folder or outside the workspace folders', () => {
    expect(formatWorkspacePath('src/app.ts', [])).toBe('src/app.ts');
    expect(formatWorkspacePath('other/app.ts', ['go-demo', 'web'])).toBe('other/app.ts');
  });
});
