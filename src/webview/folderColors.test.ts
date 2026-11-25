import { describe, expect, it } from 'vitest';

import {
  FOLDER_PALETTE,
  WORKSPACE_PALETTE,
  assignFolderColors,
  directFolderOf,
  lighterShade,
  listFolderColors,
  listWorkspaceColors,
} from './folderColors';

describe('folder colors', () => {
  it('uses the direct folder of a file', () => {
    expect(directFolderOf('src/controllers/a.ts')).toBe('src/controllers');
    expect(directFolderOf('root.ts')).toBe('');
  });

  it('gives distinct colors while the palette has room, ancestors included', () => {
    const files = [
      'src/controllers/a.ts',
      'src/services/b.ts',
      'src/routes/c.ts',
      'src/utils/d.ts',
      'src/types/e.ts',
      'src/webview/f.ts',
      'src/shared/g.ts',
      'top.ts',
    ];
    const colors = assignFolderColors(files);
    expect([...colors.keys()].sort()).toEqual([
      'src',
      'src/controllers',
      'src/routes',
      'src/services',
      'src/shared',
      'src/types',
      'src/utils',
      'src/webview',
    ]);
    expect(new Set(colors.values()).size).toBe(colors.size);
    expect([...colors.values()].every((color) => FOLDER_PALETTE.includes(color))).toBe(true);
  });

  it('depends only on the set of folders', () => {
    const a = assignFolderColors(['x/a.ts', 'y/b.ts', 'z/c.ts']);
    const b = assignFolderColors(['z/c.ts', 'y/b.ts', 'x/a.ts', 'x/d.ts']);
    expect(b).toEqual(a);
  });

  it('shares colors only when there are more folders than colors', () => {
    const files = Array.from({ length: FOLDER_PALETTE.length + 3 }, (_, i) => `f${String(i)}/a.ts`);
    expect(new Set(assignFolderColors(files).values()).size).toBe(FOLDER_PALETTE.length);
  });

  it('lists folders by size with their colors', () => {
    const files = ['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts', 'top.ts'];
    const entries = listFolderColors(files);
    expect(entries.map((entry) => [entry.folder, entry.fileCount])).toEqual([
      ['src/a', 2],
      ['src/b', 1],
    ]);
    expect(entries[0]?.color).toBe(assignFolderColors(files).get('src/a'));
  });
});

describe('workspace folder colors', () => {
  const files = [
    'web/src/app.ts',
    'web/src/services/user.ts',
    'web/src/services/auth.ts',
    'web/index.ts',
    'api/internal/db/repo.go',
  ];

  it('colors everything inside a workspace folder after it', () => {
    const colors = assignFolderColors(files, ['web', 'api']);
    const [webColor = '', apiColor = ''] = WORKSPACE_PALETTE;
    expect(colors.get('web')).toBe(webColor);
    expect(colors.get('web/src')).toBe(lighterShade(webColor));
    expect(colors.get('web/src/services')).toBe(lighterShade(webColor));
    expect(colors.get('api')).toBe(apiColor);
    expect(colors.get('api/internal/db')).toBe(lighterShade(apiColor));
  });

  it('lists the workspace folders in workspace order with their largest folders', () => {
    expect(listWorkspaceColors(files, ['web', 'api'])).toEqual([
      {
        root: 'web',
        color: WORKSPACE_PALETTE[0],
        fileCount: 4,
        folders: ['src/services', 'src'],
      },
      { root: 'api', color: WORKSPACE_PALETTE[1], fileCount: 1, folders: ['internal/db'] },
    ]);
  });
});
