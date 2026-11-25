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
        options: { collapseMode: 'always', folderViewMode: 'auto', scrollBehavior: 'auto' },
      },
    ],
    [
      {
        type: 'options',
        options: { collapseMode: 'auto', folderViewMode: 'always', scrollBehavior: 'auto' },
      },
    ],
    [
      {
        type: 'options',
        options: { collapseMode: 'never', folderViewMode: 'never', scrollBehavior: 'auto' },
      },
    ],
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
        options: { collapseMode: 'sometimes', folderViewMode: 'auto', scrollBehavior: 'auto' },
      },
    ],
    [{ type: 'options', options: { collapseMode: 'always' } }],
    [
      {
        type: 'options',
        options: { collapseMode: 'always', folderViewMode: 'maybe', scrollBehavior: 'auto' },
      },
    ],
    [
      {
        type: 'options',
        options: { collapseMode: 'always', folderViewMode: 'auto', scrollBehavior: 'fly' },
      },
    ],
    [{ type: 'options', options: { collapseMode: 'always', folderViewMode: 'auto' } }],
    [{ type: 'options' }],
    [{ type: 'options', options: [] }],
  ])('rejects %j', (message) => {
    expect(isHostToWebviewMessage(message)).toBe(false);
  });
});
