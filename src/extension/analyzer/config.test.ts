import { describe, expect, it } from 'vitest';

import { SOURCE_GLOB, isAnalyzableFile } from './config';

describe('isAnalyzableFile', () => {
  it.each(['src/a.ts', 'src/b.tsx', 'lib/c.js', 'ui/d.jsx', 'root.ts'])('accepts %s', (path) => {
    expect(isAnalyzableFile(path)).toBe(true);
  });

  it.each([
    'src/types.d.ts',
    'README.md',
    'styles.css',
    'node_modules/pkg/index.js',
    'packages/app/node_modules/x/a.ts',
    'dist/extension.js',
    'build/out.js',
    '.git/hooks/a.js',
  ])('rejects %s', (path) => {
    expect(isAnalyzableFile(path)).toBe(false);
  });

  it('does not reject names that merely contain an excluded word', () => {
    expect(isAnalyzableFile('src/distance.ts')).toBe(true);
    expect(isAnalyzableFile('src/builder/index.ts')).toBe(true);
  });
});

describe('globs', () => {
  it('builds the findFiles include pattern', () => {
    expect(SOURCE_GLOB).toBe('**/*.{ts,tsx,js,jsx}');
  });
});
