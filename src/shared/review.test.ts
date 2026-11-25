import { describe, expect, it } from 'vitest';

import { isHostToWebviewMessage, isWebviewToHostMessage } from './messages';
import type { ReviewResult } from './review';
import { changedNodeIds, createFileId, isReviewState } from './index';

const RESULT: ReviewResult = {
  mode: 'base',
  base: 'main · 1a2b3c4',
  truncated: false,
  files: [
    {
      filePath: 'a.ts',
      status: 'modified',
      added: 1,
      removed: 0,
      inGraph: true,
      topLevel: false,
      functions: [{ nodeId: 'a.ts#run', added: 1, removed: 0 }],
    },
    {
      filePath: 'b.ts',
      status: 'added',
      added: 3,
      removed: 0,
      inGraph: true,
      topLevel: false,
      functions: [],
    },
    {
      filePath: 'c.md',
      status: 'modified',
      added: 1,
      removed: 0,
      inGraph: false,
      topLevel: false,
      functions: [],
    },
  ],
};

describe('review protocol', () => {
  it('validates review states', () => {
    expect(isReviewState({ status: 'loading', mode: 'uncommitted' })).toBe(true);
    expect(isReviewState({ status: 'ready', result: RESULT })).toBe(true);
    expect(
      isReviewState({ status: 'unavailable', mode: 'base', problem: 'no-repo', message: 'x' }),
    ).toBe(true);
    expect(isReviewState({ status: 'loading', mode: 'everything' })).toBe(false);
    expect(isReviewState({ status: 'ready', result: { mode: 'base' } })).toBe(false);
  });

  it('validates review messages in both directions', () => {
    expect(isWebviewToHostMessage({ type: 'review', mode: 'lastCommit' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'review', mode: null })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'review', mode: 'HEAD~3' })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'review', mode: 'base', branch: 'release/2' })).toBe(
      true,
    );
    expect(isWebviewToHostMessage({ type: 'review', mode: 'base', branch: 7 })).toBe(false);
    expect(
      isHostToWebviewMessage({
        type: 'review',
        state: null,
        open: false,
        branches: ['main'],
        branch: '',
      }),
    ).toBe(true);
    expect(isHostToWebviewMessage({ type: 'review', state: null, open: false })).toBe(false);
    expect(
      isHostToWebviewMessage({ type: 'review', state: { status: 'loading', mode: 'base' } }),
    ).toBe(false);
  });

  it('lists the changed nodes: functions, new files and top-level changes', () => {
    expect([...changedNodeIds(RESULT, createFileId)]).toEqual(['a.ts#run', 'b.ts']);
  });
});
