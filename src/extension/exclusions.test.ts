import { describe, expect, it } from 'vitest';

import { GitignoreFilter, buildExcludeGlob } from './exclusions';

describe('buildExcludeGlob', () => {
  it('merges built-in directories with enabled files.exclude patterns', () => {
    expect(
      buildExcludeGlob({ '**/generated': true, '**/*.snap': true, '**/off': false, '**/x': {} }),
    ).toBe(
      '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/.tox/**,**/site-packages/**,**/generated,**/generated/**,**/*.snap,**/*.snap/**}',
    );
  });

  it('uses only built-in directories without settings', () => {
    expect(buildExcludeGlob()).toBe(
      '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/.tox/**,**/site-packages/**}',
    );
  });
});

describe('GitignoreFilter', () => {
  const filter = new GitignoreFilter([
    { directory: '', content: '# comment\ncoverage\n*.gen.ts\n!keep.gen.ts\n/root-only.ts\n' },
    { directory: 'packages/app', content: 'fixtures/\n' },
  ]);

  it.each([
    ['coverage/report.ts', true],
    ['src/coverage/x.ts', true],
    ['src/a.gen.ts', true],
    ['src/keep.gen.ts', false],
    ['root-only.ts', true],
    ['src/root-only.ts', false],
    ['packages/app/fixtures/a.ts', true],
    ['fixtures/a.ts', false],
    ['packages/other/fixtures/a.ts', false],
    ['src/index.ts', false],
  ])('%s ignored: %s', (filePath, expected) => {
    expect(filter.isIgnored(filePath)).toBe(expected);
  });

  it('ignores nothing when empty', () => {
    expect(GitignoreFilter.EMPTY.isIgnored('a.ts')).toBe(false);
    expect(GitignoreFilter.EMPTY.size).toBe(0);
    expect(filter.size).toBe(2);
  });
});
