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
    expect(DEFAULT_SETTINGS).toEqual({ collapseByDefault: 'always', folderView: 'auto' });
  });

  it('reads valid values', () => {
    expect(readSettings(config({ collapseByDefault: 'never', folderView: 'always' }))).toEqual({
      collapseByDefault: 'never',
      folderView: 'always',
    });
  });

  it('falls back to defaults for invalid values', () => {
    expect(readSettings(config({ collapseByDefault: 'sometimes', folderView: 'x' }))).toEqual(
      DEFAULT_SETTINGS,
    );
  });
});

describe('toViewOptions', () => {
  it('maps the settings the webview needs', () => {
    expect(toViewOptions({ collapseByDefault: 'auto', folderView: 'never' })).toEqual({
      collapseMode: 'auto',
      folderViewMode: 'never',
    });
  });

  it('groups by folder when several workspace folders are open, unless disabled', () => {
    expect(toViewOptions({ collapseByDefault: 'auto', folderView: 'auto' }, 2).folderViewMode).toBe(
      'always',
    );
    expect(
      toViewOptions({ collapseByDefault: 'auto', folderView: 'never' }, 2).folderViewMode,
    ).toBe('never');
    expect(toViewOptions({ collapseByDefault: 'auto', folderView: 'auto' }, 1).folderViewMode).toBe(
      'auto',
    );
  });
});
