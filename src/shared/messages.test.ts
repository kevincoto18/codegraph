import { describe, expect, it } from 'vitest';

import { isHostToWebviewMessage, isWebviewToHostMessage } from './messages';
import { DEFAULT_VIEW_PREFERENCES } from './preferences';

describe('isWebviewToHostMessage', () => {
  it.each([
    [{ type: 'ready' }],
    [{ type: 'refresh' }],
    [{ type: 'navigate', filePath: 'src/a.ts', line: 3 }],
    [{ type: 'metrics', samples: [] }],
    [{ type: 'metrics', samples: [{ name: 'layout.full', value: 12.5 }] }],
    [{ type: 'preferences', preferences: DEFAULT_VIEW_PREFERENCES }],
    [{ type: 'details', requestId: 7, nodeId: 'a.ts#f' }],
  ])('accepts %j', (message) => {
    expect(isWebviewToHostMessage(message)).toBe(true);
  });

  it.each([
    [null],
    [[]],
    ['ready'],
    [{ type: 'unknown' }],
    [{ type: 'navigate', filePath: '', line: 1 }],
    [{ type: 'navigate', filePath: 'a.ts', line: 0 }],
    [{ type: 'navigate', filePath: 'a.ts', line: 1.5 }],
    [{ type: 'metrics' }],
    [{ type: 'metrics', samples: [{ name: '', value: 1 }] }],
    [{ type: 'metrics', samples: [{ name: 'x', value: -1 }] }],
    [{ type: 'metrics', samples: [{ name: 'x', value: Number.NaN }] }],
    [{ type: 'metrics', samples: Array.from({ length: 101 }, () => ({ name: 'x', value: 1 })) }],
    [{ type: 'preferences' }],
    [{ type: 'preferences', preferences: { editorSync: true } }],
    [{ type: 'details', requestId: 0, nodeId: 'a.ts#f' }],
    [{ type: 'details', requestId: 1, nodeId: '' }],
    [{ type: 'details', requestId: 1 }],
  ])('rejects %j', (message) => {
    expect(isWebviewToHostMessage(message)).toBe(false);
  });
});

describe('isHostToWebviewMessage', () => {
  const patch = {
    version: 2,
    upsertNodes: [],
    removeNodeIds: [],
    upsertEdges: [],
    removeEdgeIds: [],
  };

  it.each([
    [{ type: 'graph/init', version: 1, index: 0, last: true, chunk: { files: [], edges: [] } }],
    [{ type: 'graph/patch', patch }],
    [{ type: 'focus', nodeId: 'src/a.ts#run' }],
    [{ type: 'reveal', nodeId: 'src/a.ts' }],
    [{ type: 'preferences', preferences: DEFAULT_VIEW_PREFERENCES }],
    [{ type: 'status', state: 'analyzing' }],
    [{ type: 'status', state: 'error', message: 'boom' }],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'always',
          folderViewMode: 'auto',
          scrollBehavior: 'auto',
          workspaceRoots: [],
        },
      },
    ],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'auto',
          folderViewMode: 'always',
          scrollBehavior: 'auto',
          workspaceRoots: [],
        },
      },
    ],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'never',
          folderViewMode: 'never',
          scrollBehavior: 'auto',
          workspaceRoots: [],
        },
      },
    ],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'always',
          folderViewMode: 'always',
          scrollBehavior: 'pan',
          workspaceRoots: ['api', 'web'],
        },
      },
    ],
    [{ type: 'details', requestId: 1, nodeId: 'a.ts#f', details: null }],
    [
      {
        type: 'details',
        requestId: 2,
        nodeId: 'a.ts#f',
        details: { signature: 'f(): void', doc: 'Runs.' },
      },
    ],
    [{ type: 'details', requestId: 3, nodeId: 'a.ts#f', details: { signature: 'f()', doc: null } }],
  ])('accepts %j', (message) => {
    expect(isHostToWebviewMessage(message)).toBe(true);
  });

  it.each([
    [{ type: 'graph/init', version: 0, index: 0, last: true, chunk: { files: [], edges: [] } }],
    [{ type: 'graph/init', version: 1, index: -1, last: true, chunk: { files: [], edges: [] } }],
    [{ type: 'graph/init', version: 1, index: 0, last: 'yes', chunk: { files: [], edges: [] } }],
    [{ type: 'graph/init', version: 1, index: 0, last: true, chunk: { files: [] } }],
    [{ type: 'graph/patch', patch: { version: 2 } }],
    [{ type: 'focus', nodeId: '' }],
    [{ type: 'focus' }],
    [{ type: 'reveal', nodeId: '' }],
    [{ type: 'preferences', preferences: null }],
    [{ type: 'status', state: 'done' }],
    [{ type: 'status', state: 'error', message: 42 }],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'sometimes',
          folderViewMode: 'auto',
          scrollBehavior: 'auto',
          workspaceRoots: [],
        },
      },
    ],
    [{ type: 'options', options: { collapseMode: 'always' } }],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'always',
          folderViewMode: 'maybe',
          scrollBehavior: 'auto',
          workspaceRoots: [],
        },
      },
    ],
    [
      {
        type: 'options',
        options: { collapseMode: 'always', folderViewMode: 'auto', scrollBehavior: 'fly' },
      },
    ],
    [{ type: 'options', options: { collapseMode: 'always', folderViewMode: 'auto' } }],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'always',
          folderViewMode: 'auto',
          scrollBehavior: 'auto',
          workspaceRoots: ['a/b'],
        },
      },
    ],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'always',
          folderViewMode: 'auto',
          scrollBehavior: 'auto',
          workspaceRoots: [''],
        },
      },
    ],
    [
      {
        type: 'options',
        options: {
          collapseMode: 'always',
          folderViewMode: 'auto',
          scrollBehavior: 'auto',
          workspaceRoots: 'api',
        },
      },
    ],
    [{ type: 'options' }],
    [{ type: 'options', options: [] }],
    [{ type: 'details', requestId: 1, nodeId: 'a.ts#f', details: { signature: 1, doc: null } }],
    [{ type: 'details', requestId: 1, nodeId: 'a.ts#f', details: { signature: 'f()', doc: 2 } }],
    [
      {
        type: 'details',
        requestId: 1,
        nodeId: 'a.ts#f',
        details: { signature: 'x'.repeat(2001), doc: null },
      },
    ],
    [{ type: 'details', requestId: 1, nodeId: 'a.ts#f' }],
  ])('rejects %j', (message) => {
    expect(isHostToWebviewMessage(message)).toBe(false);
  });
});
