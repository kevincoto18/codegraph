import { describe, expect, it } from 'vitest';

import { getLanguageBadge } from './languageBadge';

describe('getLanguageBadge', () => {
  it.each([
    ['src/a.ts', 'TS', 'typescript'],
    ['src/App.tsx', 'TSX', 'typescript'],
    ['legacy/server.js', 'JS', 'javascript'],
    ['app/main.py', 'PY', 'python'],
    ['src/main/java/App.java', 'JAVA', 'java'],
    ['Services/UserService.cs', 'C#', 'csharp'],
    ['cmd/main.go', 'GO', 'go'],
    ['Main.KT', 'KT', 'other'],
  ])('labels %s', (path, label, language) => {
    expect(getLanguageBadge(path)).toMatchObject({ label, language });
  });

  it('handles files without an extension', () => {
    expect(getLanguageBadge('Makefile')).toMatchObject({ label: '', language: 'other' });
  });
});
