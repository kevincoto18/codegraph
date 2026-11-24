import { describe, expect, it } from 'vitest';

import {
  addRootPrefix,
  assignRootPrefixes,
  findContainingRoot,
  relativeUriPath,
  splitRootPrefix,
} from './rootPaths';

describe('assignRootPrefixes', () => {
  it('keeps paths unprefixed for a single folder', () => {
    expect(assignRootPrefixes(['app'])).toEqual(['']);
  });

  it('names folders after the workspace folders, made unique', () => {
    expect(assignRootPrefixes(['api', 'web', 'api', 'a/b', ' '])).toEqual([
      'api',
      'web',
      'api-2',
      'a-b',
      'folder5',
    ]);
  });
});

describe('root prefixes', () => {
  it('adds and splits prefixes', () => {
    expect(addRootPrefix('', 'src/a.ts')).toBe('src/a.ts');
    expect(addRootPrefix('web', 'src/a.ts')).toBe('web/src/a.ts');
    expect(splitRootPrefix('web/src/a.ts', ['api', 'web'])).toEqual({ index: 1, path: 'src/a.ts' });
    expect(splitRootPrefix('src/a.ts', [''])).toEqual({ index: 0, path: 'src/a.ts' });
    expect(splitRootPrefix('other/a.ts', ['api', 'web'])).toBeNull();
  });

  it('finds the deepest folder that contains a path', () => {
    const roots = ['/repo', '/repo/packages/api', '/other'];
    expect(findContainingRoot('/repo/packages/api/src/a.ts', roots)).toBe(1);
    expect(findContainingRoot('/repo/src/a.ts', roots)).toBe(0);
    expect(findContainingRoot('/repository/a.ts', roots)).toBe(-1);
  });
});

describe('relativeUriPath', () => {
  it('returns the path inside the folder', () => {
    expect(relativeUriPath('/home/me/app', '/home/me/app/src/a.ts')).toBe('src/a.ts');
    expect(relativeUriPath('/home/me/app/', '/home/me/app/src')).toBe('src');
  });

  it('rejects the folder itself, siblings and outside paths', () => {
    expect(relativeUriPath('/home/me/app', '/home/me/app')).toBeNull();
    expect(relativeUriPath('/home/me/app', '/home/me/app2/a.ts')).toBeNull();
    expect(relativeUriPath('/home/me/app', '/home/me/a.ts')).toBeNull();
  });

  it('is case-sensitive outside Windows', () => {
    expect(relativeUriPath('/home/me/App', '/home/me/app/a.ts')).toBeNull();
  });

  it('ignores letter case on Windows paths and keeps the file casing', () => {
    expect(
      relativeUriPath(
        '/c:/Users/Kevin/OneDrive/Documentos/demo',
        '/C:/users/kevin/onedrive/documentos/demo/src/App.ts',
      ),
    ).toBe('src/App.ts');
    expect(relativeUriPath('/c:/work/demo', '/d:/work/demo/a.ts')).toBeNull();
  });

  it('finds Windows roots whatever the casing', () => {
    expect(findContainingRoot('/C:/Work/api/a.ts', ['/c:/work/web', '/c:/work/api'])).toBe(1);
  });
});
