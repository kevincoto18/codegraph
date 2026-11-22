/**
 * Which workspace files the analyzer handles, derived from the language registry.
 */
import { EXCLUDED_DIRECTORIES } from './language';
import { LANGUAGES } from './languages';

export { EXCLUDED_DIRECTORIES };

/** File extensions of every supported language. */
export const SUPPORTED_EXTENSIONS: readonly string[] = LANGUAGES.extensions;

/** Glob matching every candidate source file (for `workspace.findFiles`). */
export const SOURCE_GLOB = LANGUAGES.sourceGlob;

/**
 * Decides whether a workspace-relative path should be analyzed.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @returns `true` if a supported language handles the file and it does not
 *   live inside an excluded directory.
 */
export function isAnalyzableFile(filePath: string): boolean {
  return LANGUAGES.isAnalyzableFile(filePath);
}
