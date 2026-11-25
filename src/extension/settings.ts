/**
 * Typed access to the `codegraph.*` extension settings.
 *
 * @remarks Reads through a minimal configuration interface instead of
 * `vscode.WorkspaceConfiguration`, so validation can be unit-tested.
 */
import type { CollapseMode, FolderViewMode, ScrollBehavior, ViewOptions } from '../shared';
import { COLLAPSE_MODES, FOLDER_VIEW_MODES, SCROLL_BEHAVIORS } from '../shared';

/** Settings section of the extension (`codegraph.*`). */
export const SETTINGS_SECTION = 'codegraph';

/** Resolved, validated extension settings. */
export interface CodeGraphSettings {
  /** Initial collapse state of file containers. */
  readonly collapseByDefault: CollapseMode;
  /** Whether files are grouped into folder containers. */
  readonly folderView: FolderViewMode;
  /** What the mouse wheel and two-finger scrolling do. */
  readonly scrollBehavior: ScrollBehavior;
}

/** Values used when a setting is missing or invalid. */
export const DEFAULT_SETTINGS: CodeGraphSettings = {
  collapseByDefault: 'always',
  folderView: 'auto',
  scrollBehavior: 'auto',
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
  const scrollBehavior = configuration.get('scrollBehavior');
  return {
    collapseByDefault: COLLAPSE_MODES.includes(collapse as CollapseMode)
      ? (collapse as CollapseMode)
      : DEFAULT_SETTINGS.collapseByDefault,
    folderView: FOLDER_VIEW_MODES.includes(folderView as FolderViewMode)
      ? (folderView as FolderViewMode)
      : DEFAULT_SETTINGS.folderView,
    scrollBehavior: SCROLL_BEHAVIORS.includes(scrollBehavior as ScrollBehavior)
      ? (scrollBehavior as ScrollBehavior)
      : DEFAULT_SETTINGS.scrollBehavior,
  };
}

/**
 * Converts settings into the options sent to the webview. With several
 * workspace folders, `auto` folder view always groups by folder, so each
 * folder appears under its own top-level node.
 *
 * @param settings - Current settings.
 * @param workspaceRoots - Top-level folder names of the workspace folders
 *   when several are open (see `rootPaths.ts`); empty with one folder.
 * @returns The webview options.
 */
export function toViewOptions(
  settings: CodeGraphSettings,
  workspaceRoots: readonly string[] = [],
): ViewOptions {
  const multiRoot = workspaceRoots.length > 1;
  return {
    collapseMode: settings.collapseByDefault,
    folderViewMode: multiRoot && settings.folderView === 'auto' ? 'always' : settings.folderView,
    scrollBehavior: settings.scrollBehavior,
    workspaceRoots: multiRoot ? workspaceRoots : [],
  };
}
