import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from './diffParser';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' import x from "x";',
  '+import y from "y";',
  ' ',
  ' function a() {',
  '-  return 1;',
  '+  return 2;',
  '@@ -20,3 +21,1 @@ function b() {',
  ' }',
  '-function gone() {',
  '-}',
  '\\ No newline at end of file',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('reads added lines and where lines were removed, in new-file lines', () => {
    const diff = parseUnifiedDiff(PATCH);
    expect(diff.addedLines).toEqual([2, 5]);
    expect(diff.removals).toEqual([
      { before: 5, count: 1, replacedBy: 5, trivial: false },
      { before: 22, count: 2, trivial: false },
    ]);
    expect([...diff.trivialLines]).toEqual([]);
    expect([diff.added, diff.removed, diff.binary]).toEqual([2, 3, false]);
  });

  it('handles new and emptied files', () => {
    expect(parseUnifiedDiff('@@ -0,0 +1,2 @@\n+a\n+b').addedLines).toEqual([1, 2]);
    expect(parseUnifiedDiff('@@ -1,2 +0,0 @@\n-a\n-b').removals).toEqual([
      { before: 1, count: 2, trivial: false },
    ]);
  });

  it('flags blank and comment-only lines', () => {
    const diff = parseUnifiedDiff('@@ -1,2 +1,4 @@\n+\n+/** Doc. */\n+run();\n-// old note\n ');
    expect([...diff.trivialLines]).toEqual([1, 2]);
    expect(diff.removals).toEqual([{ before: 4, count: 1, trivial: true }]);
  });

  it('flags binary files and ignores CRLF endings', () => {
    expect(parseUnifiedDiff('diff --git a/x b/x\nBinary files a/x and b/x differ').binary).toBe(
      true,
    );
    expect(parseUnifiedDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n').addedLines).toEqual([1]);
  });
});
