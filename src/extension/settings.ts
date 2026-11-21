/**
 * Typed access to the `codegraph.*` extension settings.
 *
 * @remarks Reads through a minimal configuration interface instead of
 * `vscode.WorkspaceConfiguration`, so validation can be unit-tested.
 */
import type { CollapseMode, FolderViewMode, ViewOptions } from '../shared';
import { COLLAPSE_MODES, FOLDER_VIEW_MODES } from '../shared';

/** Settings section of the extension (`codegraph.*`). */
export const SETTINGS_SECTION = 'codegraph';

/** Resolved, validated extension settings. */
export interface CodeGraphSettings {
  /** Initial collapse state of file containers. */
  readonly collapseByDefault: CollapseMode;
  /** Whether files are grouped into folder containers. */
  readonly folderView: FolderViewMode;
}

/** Values used when a setting is missing or invalid. */
export const DEFAULT_SETTINGS: CodeGraphSettings = {
  collapseByDefault: 'always',
  folderView: 'auto',
};

/** Minimal read-only view of a configuration section. */
export interface ConfigurationReader {
  /**
   * Reads a setting.
   *
   * @param key - Setting key relative to the section.
   * @returns The raw value, or `undefined` if unset.
   */
  get(key: string): unknown;
}

/**
 * Reads and validates the extension settings; invalid values fall back to defaults.
 *
 * @param configuration - The `codegraph` configuration section.
 * @returns The resolved settings.
 */
export function readSettings(configuration: ConfigurationReader): CodeGraphSettings {
  const collapse = configuration.get('collapseByDefault');
  const folderView = configuration.get('folderView');
  return {
    collapseByDefault: COLLAPSE_MODES.includes(collapse as CollapseMode)
      ? (collapse as CollapseMode)
      : DEFAULT_SETTINGS.collapseByDefault,
    folderView: FOLDER_VIEW_MODES.includes(folderView as FolderViewMode)
      ? (folderView as FolderViewMode)
      : DEFAULT_SETTINGS.folderView,
  };
}

/**
 * Extracts the settings the webview needs.
 *
 * @param settings - Resolved settings.
 * @returns View options to send to the webview.
 */
export function toViewOptions(settings: CodeGraphSettings): ViewOptions {
  return { collapseMode: settings.collapseByDefault, folderViewMode: settings.folderView };
}
