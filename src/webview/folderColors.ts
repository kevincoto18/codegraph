/**
 * Stable colors per folder, drawn as a thin vertical stripe on files and folders.
 */
import type { RelPath } from '../shared';

/**
 * Palette of colors distinguishable on dark and light themes: VS Code chart
 * colors first, then a few extra hues.
 */
export const FOLDER_PALETTE: readonly string[] = [
  'var(--vscode-charts-red, #f14c4c)',
  'var(--vscode-charts-orange, #d18616)',
  'var(--vscode-charts-yellow, #cca700)',
  'var(--vscode-charts-green, #89d185)',
  'var(--vscode-charts-blue, #3794ff)',
  'var(--vscode-charts-purple, #b180d7)',
  '#4ec9b0',
  '#e586c4',
  '#29b8db',
  '#b5cea8',
  '#ce9178',
  '#7c8cf8',
];

/** Name of the CSS custom property carrying a node's folder color. */
export const FOLDER_COLOR_PROPERTY = '--cg-folder-color';

/** A folder with its color and number of files, for the panel's legend. */
export interface FolderColorEntry {
  readonly folder: RelPath;
  readonly color: string;
  readonly fileCount: number;
}

/**
 * Returns the folder that directly contains a file.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @returns The folder path (`''` for files at the root).
 */
export function directFolderOf(filePath: RelPath): RelPath {
  const separator = filePath.lastIndexOf('/');
  return separator === -1 ? '' : filePath.slice(0, separator);
}

/**
 * Hashes a string (FNV-1a, 32 bits): stable across sessions and machines.
 *
 * @param text - Text to hash.
 * @returns Unsigned 32-bit hash.
 */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Lists a folder and every folder above it.
 *
 * @param folder - Workspace-relative folder path.
 * @returns The folder followed by its ancestors (the root excluded).
 */
function withAncestors(folder: RelPath): RelPath[] {
  const folders: RelPath[] = [];
  for (let current = folder; current !== ''; current = directFolderOf(current)) {
    folders.push(current);
  }
  return folders;
}

/**
 * Assigns a color to every folder of a set of files. Each folder prefers the
 * palette slot given by a hash of its path (stable across sessions); when two
 * folders want the same slot, the later one takes the next free slot, so the
 * folders of a project stay distinct as long as the palette has room.
 *
 * @remarks Folders that directly contain files are served first (they carry
 * the stripes in the flat view), then their ancestor folders, each group in
 * alphabetical order, so the result only depends on the set of folders.
 *
 * @param filePaths - Workspace-relative file paths.
 * @returns Color of each folder (the root has none).
 */
export function assignFolderColors(filePaths: Iterable<RelPath>): Map<RelPath, string> {
  const direct = new Set<RelPath>();
  for (const filePath of filePaths) {
    const folder = directFolderOf(filePath);
    if (folder !== '') {
      direct.add(folder);
    }
  }
  const ancestors = new Set<RelPath>();
  for (const folder of direct) {
    for (const ancestor of withAncestors(directFolderOf(folder))) {
      if (!direct.has(ancestor)) {
        ancestors.add(ancestor);
      }
    }
  }
  const ordered = [
    ...[...direct].sort((a, b) => a.localeCompare(b)),
    ...[...ancestors].sort((a, b) => a.localeCompare(b)),
  ];

  const colors = new Map<RelPath, string>();
  const taken = new Set<number>();
  for (const folder of ordered) {
    const preferred = hashString(folder) % FOLDER_PALETTE.length;
    let slot = preferred;
    for (let step = 0; step < FOLDER_PALETTE.length && taken.has(slot); step += 1) {
      slot = (preferred + step + 1) % FOLDER_PALETTE.length;
    }
    if (taken.has(slot)) {
      slot = preferred; // Palette full: share the preferred color.
    }
    taken.add(slot);
    colors.set(folder, FOLDER_PALETTE[slot] ?? '');
  }
  return colors;
}

/**
 * Lists the folders of a set of files with their colors, largest first.
 *
 * @param filePaths - Workspace-relative file paths.
 * @returns One entry per folder that directly contains files (the root
 *   excluded), sorted by file count then name.
 */
export function listFolderColors(filePaths: Iterable<RelPath>): FolderColorEntry[] {
  const paths = [...filePaths];
  const colors = assignFolderColors(paths);
  const counts = new Map<RelPath, number>();
  for (const filePath of paths) {
    const folder = directFolderOf(filePath);
    if (folder !== '') {
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([folder, fileCount]) => ({ folder, fileCount, color: colors.get(folder) ?? '' }))
    .sort((a, b) => b.fileCount - a.fileCount || a.folder.localeCompare(b.folder));
}
