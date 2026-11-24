/**
 * Which files are left out of the analysis besides the built-in exclusions:
 * the user's `files.exclude` setting and the workspace's `.gitignore` files.
 *
 * @remarks Pure (no VS Code API), so the rules can be unit-tested.
 */
import ignore from 'ignore';
import type { Ignore } from 'ignore';

import type { RelPath } from '../shared';
import { EXCLUDED_DIRECTORIES } from './analyzer/config';

/** Content of one `.gitignore` file. */
export interface GitignoreFile {
  /** Folder that contains the file (`''` for the workspace root). */
  readonly directory: RelPath;
  /** Raw file content. */
  readonly content: string;
}

/** Compiled rules of one `.gitignore` file. */
interface GitignoreRules {
  /** Prefix that paths must start with for the rules to apply (`''` or `dir/`). */
  readonly prefix: string;
  readonly matcher: Ignore;
}

/**
 * Builds the exclude glob passed to `workspace.findFiles`: the built-in
 * excluded directories plus every enabled `files.exclude` pattern.
 *
 * @remarks Passing an explicit exclude glob to `findFiles` disables the
 * default `files.exclude` handling, so both must be merged here. Patterns
 * with a `when` condition (object values) are skipped.
 *
 * @param filesExclude - Value of the `files.exclude` setting.
 * @returns A single brace-expanded glob.
 */
export function buildExcludeGlob(filesExclude: Readonly<Record<string, unknown>> = {}): string {
  const patterns = [
    ...EXCLUDED_DIRECTORIES.map((directory) => `**/${directory}/**`),
    ...Object.entries(filesExclude)
      .filter(([, enabled]) => enabled === true)
      .flatMap(([pattern]) => [pattern, `${pattern}/**`]),
  ];
  return `{${[...new Set(patterns)].join(',')}}`;
}

/**
 * Compiles the enabled `files.exclude` patterns and the built-in excluded
 * directories into a matcher, for when files are listed without
 * `workspace.findFiles` (see `VsCodeWorkspaceReader`).
 *
 * @remarks `files.exclude` globs are read with `.gitignore` semantics, which
 * agree on the common forms (`name`, `dir/**`, `*.ext` and the same with a
 * leading globstar).
 *
 * @param filesExclude - Value of the `files.exclude` setting.
 * @returns A function telling whether a workspace-relative path is excluded.
 */
export function createExcludeMatcher(
  filesExclude: Readonly<Record<string, unknown>> = {},
): (filePath: RelPath) => boolean {
  const matcher = ignore().add([
    ...EXCLUDED_DIRECTORIES.map((directory) => `${directory}/`),
    ...Object.entries(filesExclude)
      .filter(([, enabled]) => enabled === true)
      .map(([pattern]) => pattern),
  ]);
  return (filePath) => filePath !== '' && matcher.ignores(filePath);
}

/**
 * Checks paths against every `.gitignore` of the workspace. Each file's rules
 * apply to paths inside its folder, relative to that folder, like Git does.
 *
 * @remarks Simplification: a nested `.gitignore` cannot re-include (`!rule`)
 * a path ignored by a parent folder's `.gitignore`.
 */
export class GitignoreFilter {
  /** Filter that ignores nothing. */
  public static readonly EMPTY = new GitignoreFilter([]);

  private readonly rules: readonly GitignoreRules[];

  /**
   * Compiles the rules.
   *
   * @param files - Every `.gitignore` file of the workspace.
   */
  public constructor(files: readonly GitignoreFile[]) {
    this.rules = files.map((file) => ({
      prefix: file.directory === '' ? '' : `${file.directory}/`,
      matcher: ignore().add(file.content),
    }));
  }

  /** Number of `.gitignore` files taken into account. */
  public get size(): number {
    return this.rules.length;
  }

  /**
   * Checks whether a path is ignored by any applicable `.gitignore`.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns `true` if the path must be left out.
   */
  public isIgnored(filePath: RelPath): boolean {
    return this.rules.some(
      ({ prefix, matcher }) =>
        filePath.startsWith(prefix) && matcher.ignores(filePath.slice(prefix.length)),
    );
  }
}
