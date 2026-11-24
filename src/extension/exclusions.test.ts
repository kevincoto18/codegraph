import { describe, expect, it } from 'vitest';

import { GitignoreFilter, buildExcludeGlob, createExcludeMatcher } from './exclusions';

describe('buildExcludeGlob', () => {
  it('merges built-in directories with enabled files.exclude patterns', () => {
    expect(
      buildExcludeGlob({ '**/generated': true, '**/*.snap': true, '**/off': false, '**/x': {} }),
    ).toBe(
      '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/.tox/**,**/site-packages/**,**/vendor/**,**/target/**,**/obj/**,**/.gradle/**,**/generated,**/generated/**,**/*.snap,**/*.snap/**}',
    );
  });

  it('uses only built-in directories without settings', () => {
    expect(buildExcludeGlob()).toBe(
      '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/.tox/**,**/site-packages/**,**/vendor/**,**/target/**,**/obj/**,**/.gradle/**}',
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

describe('createExcludeMatcher', () => {
  it('excludes the built-in folders at any depth', () => {
    const isExcluded = createExcludeMatcher();
    expect(isExcluded('node_modules/')).toBe(true);
    expect(isExcluded('packages/web/node_modules/')).toBe(true);
    expect(isExcluded('packages/web/node_modules/react/index.js')).toBe(true);
    expect(isExcluded('src/app.ts')).toBe(false);
    expect(isExcluded('')).toBe(false);
  });

  it('applies the enabled files.exclude patterns only', () => {
    const isExcluded = createExcludeMatcher({
      '**/generated': true,
      '**/*.min.js': true,
      'legacy/**': true,
      '**/kept': false,
      '**/conditional': { when: '$(basename).ts' },
    });
    expect(isExcluded('src/generated/')).toBe(true);
    expect(isExcluded('src/generated/api.ts')).toBe(true);
    expect(isExcluded('public/app.min.js')).toBe(true);
    expect(isExcluded('legacy/server.js')).toBe(true);
    expect(isExcluded('src/kept/')).toBe(false);
    expect(isExcluded('src/conditional/')).toBe(false);
    expect(isExcluded('src/app.js')).toBe(false);
  });
});
