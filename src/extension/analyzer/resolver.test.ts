import { describe, expect, it } from 'vitest';

import { buildCandidatePaths, isRelativeSpecifier, resolveImport } from './resolver';

/** Workspace files available to every resolution test. */
const KNOWN_FILES: ReadonlySet<string> = new Set([
  'src/index.ts',
  'src/utils/math.ts',
  'src/utils/index.ts',
  'src/components/Button.tsx',
  'src/legacy/helper.js',
  'src/legacy/view.jsx',
  'src/esm/target.ts',
  'src/exact.js',
]);

describe('isRelativeSpecifier', () => {
  it.each(['./a', '../a', '.', '..'])('treats %s as relative', (specifier) => {
    expect(isRelativeSpecifier(specifier)).toBe(true);
  });

  it.each(['react', '@scope/pkg', '@/alias', 'src/a', '/abs/a'])(
    'treats %s as non-relative',
    (specifier) => {
      expect(isRelativeSpecifier(specifier)).toBe(false);
    },
  );
});

describe('buildCandidatePaths', () => {
  it('lists exact path, extensions, then index files', () => {
    expect(buildCandidatePaths('src/a')).toEqual([
      'src/a',
      'src/a.ts',
      'src/a.tsx',
      'src/a.js',
      'src/a.jsx',
      'src/a/index.ts',
      'src/a/index.tsx',
      'src/a/index.js',
      'src/a/index.jsx',
    ]);
  });

  it('adds TypeScript counterparts for a .js specifier right after the exact path', () => {
    expect(buildCandidatePaths('src/a.js').slice(0, 3)).toEqual([
      'src/a.js',
      'src/a.ts',
      'src/a.tsx',
    ]);
  });
});

describe('resolveImport', () => {
  it.each([
    ['src/index.ts', './utils/math', 'src/utils/math.ts'],
    ['src/index.ts', './components/Button', 'src/components/Button.tsx'],
    ['src/index.ts', './legacy/helper', 'src/legacy/helper.js'],
    ['src/index.ts', './legacy/view', 'src/legacy/view.jsx'],
    ['src/index.ts', './utils', 'src/utils/index.ts'],
    ['src/utils/math.ts', '..', 'src/index.ts'],
    ['src/utils/math.ts', '.', 'src/utils/index.ts'],
    ['src/utils/math.ts', '../components/Button', 'src/components/Button.tsx'],
    ['src/index.ts', './esm/target.js', 'src/esm/target.ts'],
    ['src/index.ts', './exact.js', 'src/exact.js'],
    ['src/index.ts', './utils/../utils/math', 'src/utils/math.ts'],
  ])('from %s resolves %s to %s', (fromFile, specifier, expected) => {
    expect(resolveImport(fromFile, specifier, KNOWN_FILES)).toBe(expected);
  });

  it.each([
    ['package import', 'react'],
    ['path alias', '@/utils/math'],
    ['unknown file', './missing'],
    ['path outside the workspace', '../../outside'],
  ])('returns null for a %s', (_label, specifier) => {
    expect(resolveImport('src/index.ts', specifier, KNOWN_FILES)).toBeNull();
  });
});
