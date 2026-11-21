import { describe, expect, it } from 'vitest';

import { isHostToWebviewMessage, isWebviewToHostMessage } from './messages';

describe('isWebviewToHostMessage', () => {
  it.each([
    [{ type: 'ready' }],
    [{ type: 'refresh' }],
    [{ type: 'navigate', filePath: 'src/a.ts', line: 3 }],
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
    [{ type: 'graph/init', graph: { version: 1, nodes: [], edges: [] } }],
    [{ type: 'graph/patch', patch }],
    [{ type: 'status', state: 'analyzing' }],
    [{ type: 'status', state: 'error', message: 'boom' }],
    [{ type: 'options', options: { collapseMode: 'always' } }],
    [{ type: 'options', options: { collapseMode: 'auto' } }],
    [{ type: 'options', options: { collapseMode: 'never' } }],
  ])('accepts %j', (message) => {
    expect(isHostToWebviewMessage(message)).toBe(true);
  });

  it.each([
    [{ type: 'graph/init', graph: { version: 0, nodes: [], edges: [] } }],
    [{ type: 'graph/patch', patch: { version: 2 } }],
    [{ type: 'status', state: 'done' }],
    [{ type: 'status', state: 'error', message: 42 }],
    [{ type: 'options', options: { collapseMode: 'sometimes' } }],
    [{ type: 'options' }],
    [{ type: 'options', options: [] }],
  ])('rejects %j', (message) => {
    expect(isHostToWebviewMessage(message)).toBe(false);
  });
});
