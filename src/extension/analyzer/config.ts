/**
 * Static configuration of which workspace files the analyzer handles.
 */

/** File extensions the analyzer can parse. */
export const SUPPORTED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx'];

/** Directory names that are never analyzed, at any depth. */
export const EXCLUDED_DIRECTORIES: readonly string[] = ['node_modules', 'dist', 'build', '.git'];

/** Glob matching every candidate source file (for `workspace.findFiles`). */
export const SOURCE_GLOB = `**/*.{${SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1)).join(',')}}`;

/** Glob matching every excluded directory (for `workspace.findFiles`). */
export const EXCLUDE_GLOB = `**/{${EXCLUDED_DIRECTORIES.join(',')}}/**`;

/** Suffix of TypeScript declaration files, which contain no function bodies. */
const DECLARATION_FILE_SUFFIX = '.d.ts';

/**
 * Decides whether a workspace-relative path should be analyzed.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @returns `true` if the file has a supported extension, is not a declaration
 *   file and does not live inside an excluded directory.
 */
export function isAnalyzableFile(filePath: string): boolean {
  if (filePath.endsWith(DECLARATION_FILE_SUFFIX)) {
    return false;
  }
  if (!SUPPORTED_EXTENSIONS.some((ext) => filePath.endsWith(ext))) {
    return false;
  }
  return !filePath.split('/').some((segment) => EXCLUDED_DIRECTORIES.includes(segment));
}
