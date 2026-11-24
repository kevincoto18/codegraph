/**
 * View preferences kept per workspace: which connections are drawn, which
 * files and functions are hidden, and whether the graph follows the editor.
 *
 * @remarks Environment-agnostic (no `vscode`, `node:*` or DOM imports): the
 * webview edits these preferences and the extension host persists them.
 */
import type { RelPath } from './types';

/** Visibility of each kind of connection. */
export interface ConnectionFilters {
  /** Imports between files. */
  readonly imports: boolean;
  /** Calls between functions of different files. */
  readonly calls: boolean;
  /** Calls between functions of the same file (only drawn when `calls` is on too). */
  readonly internalCalls: boolean;
}

/** Files and functions removed from the graph before it is drawn. */
export interface NodeFilters {
  /** Hide test files (`*.test.*`, `*.spec.*`, `test_*.py`, `__tests__/`…). */
  readonly hideTests: boolean;
  /** Keep only exported (public) functions. */
  readonly exportedOnly: boolean;
  /** Folders whose files are hidden, as workspace-relative paths. */
  readonly hiddenFolders: readonly RelPath[];
  /** Glob patterns of files to hide, e.g. `**\/generated/**` or `*.gen.ts`. */
  readonly excludePatterns: readonly string[];
}

/** Everything the user can tune in the panel that survives a reload. */
export interface ViewPreferences {
  readonly connections: ConnectionFilters;
  readonly nodes: NodeFilters;
  /** Whether the graph highlights the file or function under the editor cursor. */
  readonly editorSync: boolean;
}

/** Most hidden folders kept in the preferences. */
export const MAX_HIDDEN_FOLDERS = 500;

/** Most exclude patterns kept in the preferences. */
export const MAX_EXCLUDE_PATTERNS = 50;

/** Longest folder path or pattern accepted, in characters. */
export const MAX_PREFERENCE_TEXT_LENGTH = 500;

/** Preferences of a workspace that never changed them. */
export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = {
  connections: { imports: false, calls: true, internalCalls: false },
  nodes: { hideTests: false, exportedOnly: false, hiddenFolders: [], excludePatterns: [] },
  editorSync: false,
};

/**
 * Checks whether a value is a non-null, non-array object.
 *
 * @param value - Value to inspect.
 * @returns `true` if the value can be read as a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a value is a bounded list of non-empty, bounded strings.
 *
 * @param value - Value to inspect.
 * @param maxItems - Most items allowed.
 * @returns `true` for a valid string list.
 */
function isTextList(value: unknown, maxItems: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && item.length <= MAX_PREFERENCE_TEXT_LENGTH,
    )
  );
}

/**
 * Validates preferences received from the other side of the channel.
 *
 * @param value - Raw value.
 * @returns `true` if the value is a well-formed {@link ViewPreferences}.
 */
export function isViewPreferences(value: unknown): value is ViewPreferences {
  if (!isRecord(value) || !isRecord(value.connections) || !isRecord(value.nodes)) {
    return false;
  }
  const { connections, nodes } = value;
  return (
    typeof value.editorSync === 'boolean' &&
    typeof connections.imports === 'boolean' &&
    typeof connections.calls === 'boolean' &&
    typeof connections.internalCalls === 'boolean' &&
    typeof nodes.hideTests === 'boolean' &&
    typeof nodes.exportedOnly === 'boolean' &&
    isTextList(nodes.hiddenFolders, MAX_HIDDEN_FOLDERS) &&
    isTextList(nodes.excludePatterns, MAX_EXCLUDE_PATTERNS)
  );
}

/**
 * Reads stored preferences, falling back to the defaults when they are
 * missing or malformed (e.g. written by an older version).
 *
 * @param value - Value read from storage.
 * @returns Valid preferences.
 */
export function readViewPreferences(value: unknown): ViewPreferences {
  return isViewPreferences(value) ? value : DEFAULT_VIEW_PREFERENCES;
}
