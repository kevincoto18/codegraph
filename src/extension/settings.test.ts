import { describe, expect, it } from 'vitest';

import type { ConfigurationReader } from './settings';
import { DEFAULT_SETTINGS, readSettings, toViewOptions } from './settings';

/**
 * Creates a configuration reader backed by a plain object.
 *
 * @param values - Setting values by key.
 * @returns The reader.
 */
function config(values: Record<string, unknown>): ConfigurationReader {
  return { get: (key) => values[key] };
}

describe('readSettings', () => {
  it('uses defaults when nothing is configured', () => {
    expect(readSettings(config({}))).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      collapseByDefault: 'always',
      folderView: 'auto',
      scrollBehavior: 'auto',
    });
  });

  it('reads valid values', () => {
    expect(
      readSettings(
        config({ collapseByDefault: 'never', folderView: 'always', scrollBehavior: 'pan' }),
      ),
    ).toEqual({
      collapseByDefault: 'never',
      folderView: 'always',
      scrollBehavior: 'pan',
    });
  });

  it('falls back to defaults for invalid values', () => {
    expect(
      readSettings(
        config({ collapseByDefault: 'sometimes', folderView: 'x', scrollBehavior: 'fly' }),
      ),
    ).toEqual(DEFAULT_SETTINGS);
  });
});

describe('toViewOptions', () => {
  it('maps the settings the webview needs', () => {
    expect(
      toViewOptions({ collapseByDefault: 'auto', folderView: 'never', scrollBehavior: 'zoom' }),
    ).toEqual({
      collapseMode: 'auto',
      folderViewMode: 'never',
      scrollBehavior: 'zoom',
      workspaceRoots: [],
    });
  });

  it('lists the workspace folders only when several are open', () => {
    const settings = {
      collapseByDefault: 'auto',
      folderView: 'auto',
      scrollBehavior: 'auto',
    } as const;
    expect(toViewOptions(settings, ['api', 'web']).workspaceRoots).toEqual(['api', 'web']);
    expect(toViewOptions(settings, ['api']).workspaceRoots).toEqual([]);
  });

  it('groups by folder when several workspace folders are open, unless disabled', () => {
    expect(
      toViewOptions({ collapseByDefault: 'auto', folderView: 'auto', scrollBehavior: 'auto' }, [
        'api',
        'web',
      ]).folderViewMode,
    ).toBe('always');
    expect(
      toViewOptions({ collapseByDefault: 'auto', folderView: 'never', scrollBehavior: 'auto' }, [
        'api',
        'web',
      ]).folderViewMode,
    ).toBe('never');
    expect(
      toViewOptions({ collapseByDefault: 'auto', folderView: 'auto', scrollBehavior: 'auto' }, [])
        .folderViewMode,
    ).toBe('auto');
  });
});
