import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEW_PREFERENCES,
  MAX_EXCLUDE_PATTERNS,
  isViewPreferences,
  readViewPreferences,
} from './preferences';

describe('isViewPreferences', () => {
  it('accepts the defaults and custom filters', () => {
    expect(isViewPreferences(DEFAULT_VIEW_PREFERENCES)).toBe(true);
    expect(
      isViewPreferences({
        connections: { imports: true, calls: false, internalCalls: true },
        nodes: {
          hideTests: true,
          exportedOnly: true,
          hiddenFolders: ['src/legacy'],
          excludePatterns: ['**/*.gen.ts'],
        },
        editorSync: true,
      }),
    ).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isViewPreferences(null)).toBe(false);
    expect(isViewPreferences({ ...DEFAULT_VIEW_PREFERENCES, editorSync: 'yes' })).toBe(false);
    expect(
      isViewPreferences({
        ...DEFAULT_VIEW_PREFERENCES,
        nodes: { ...DEFAULT_VIEW_PREFERENCES.nodes, hiddenFolders: [''] },
      }),
    ).toBe(false);
    expect(
      isViewPreferences({
        ...DEFAULT_VIEW_PREFERENCES,
        nodes: {
          ...DEFAULT_VIEW_PREFERENCES.nodes,
          excludePatterns: Array.from({ length: MAX_EXCLUDE_PATTERNS + 1 }, () => '*.js'),
        },
      }),
    ).toBe(false);
  });
});

describe('readViewPreferences', () => {
  it('falls back to the defaults for missing or old values', () => {
    expect(readViewPreferences(undefined)).toBe(DEFAULT_VIEW_PREFERENCES);
    expect(readViewPreferences({ connections: {} })).toBe(DEFAULT_VIEW_PREFERENCES);
  });
});
