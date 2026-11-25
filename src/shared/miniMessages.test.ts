import { describe, expect, it } from 'vitest';

import { isMiniHostToViewMessage, isMiniViewToHostMessage } from './miniMessages';

describe('isMiniViewToHostMessage', () => {
  it.each([
    [{ type: 'mini/ready' }],
    [{ type: 'mini/open', nodeId: 'src/a.ts' }],
    [{ type: 'mini/graph', nodeId: 'src/a.ts' }],
    [{ type: 'mini/mode', mode: 'functions' }],
  ])('accepts %j', (message) => {
    expect(isMiniViewToHostMessage(message)).toBe(true);
  });

  it.each([
    [null],
    [{ type: 'mini/open' }],
    [{ type: 'mini/open', nodeId: '' }],
    [{ type: 'mini/mode', mode: 'classes' }],
    [{ type: 'mini/center', nodeId: 'src/a.ts' }],
    [{ type: 'ready' }],
  ])('rejects %j', (message) => {
    expect(isMiniViewToHostMessage(message)).toBe(false);
  });
});

describe('isMiniHostToViewMessage', () => {
  const center = {
    id: 'a.ts',
    kind: 'file',
    label: 'a.ts',
    detail: '',
    filePath: 'a.ts',
    line: 1,
  };

  it('accepts graphs and empty states', () => {
    expect(
      isMiniHostToViewMessage({
        type: 'mini/graph',
        graph: { mode: 'files', center, members: [], incoming: [], outgoing: [] },
      }),
    ).toBe(true);
    expect(
      isMiniHostToViewMessage({ type: 'mini/empty', mode: 'files', reason: 'no-editor' }),
    ).toBe(true);
  });

  it('rejects malformed messages', () => {
    expect(isMiniHostToViewMessage({ type: 'mini/graph', graph: { mode: 'files' } })).toBe(false);
    expect(isMiniHostToViewMessage({ type: 'mini/empty', mode: 'x', reason: 'no-editor' })).toBe(
      false,
    );
    expect(isMiniHostToViewMessage({ type: 'graph/init' })).toBe(false);
  });
});
