/**
 * Change review ("PR review mode"): which files and functions a set of git
 * changes touches, sent by the host so the webview can show their impact.
 */
import type { RelPath } from './types';

/**
 * What the working tree is compared with: the branch it will be merged into
 * (from where it branched off), the last commit (uncommitted changes only),
 * or the commit before it (last commit plus uncommitted changes).
 */
export type ReviewMode = 'base' | 'uncommitted' | 'lastCommit';

/** Every valid {@link ReviewMode}. */
export const REVIEW_MODES: readonly ReviewMode[] = ['base', 'uncommitted', 'lastCommit'];

/** How a file changed. */
export type ReviewFileStatus = 'modified' | 'added' | 'deleted' | 'renamed';

/** A function touched by the changes. */
export interface ReviewFunction {
  readonly nodeId: string;
  /** Lines added inside it. */
  readonly added: number;
  /** Lines removed inside it. */
  readonly removed: number;
}

/** A changed file. */
export interface ReviewFile {
  readonly filePath: RelPath;
  readonly status: ReviewFileStatus;
  readonly added: number;
  readonly removed: number;
  /** Whether the file is part of the graph (analyzed language, not excluded). */
  readonly inGraph: boolean;
  /** Whether lines outside every function changed (imports, top-level code). */
  readonly topLevel: boolean;
  /** Touched functions, in file order. */
  readonly functions: readonly ReviewFunction[];
}

/** Changes found for a mode. */
export interface ReviewResult {
  readonly mode: ReviewMode;
  /** What the working tree was compared with, e.g. `main · 1a2b3c4`. */
  readonly base: string;
  readonly files: readonly ReviewFile[];
  /** Whether some changed files were left out (too many). */
  readonly truncated: boolean;
}

/** Why a review could not be computed. */
export type ReviewProblem = 'no-git' | 'no-repo' | 'no-base' | 'error';

/** State of the review shown in the webview. */
export type ReviewState =
  | { readonly status: 'loading'; readonly mode: ReviewMode }
  | { readonly status: 'ready'; readonly result: ReviewResult }
  | {
      readonly status: 'unavailable';
      readonly mode: ReviewMode;
      readonly problem: ReviewProblem;
      readonly message: string;
    };

/** Most changed files reported in one review. */
export const MAX_REVIEW_FILES = 500;

/**
 * Checks that a value is a plain object.
 *
 * @param value - Value to check.
 * @returns `true` for non-null objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a review state (shallow: the host is a trusted producer).
 *
 * @param value - Raw value.
 * @returns `true` for a well-formed {@link ReviewState}.
 */
export function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.status) {
    case 'loading':
      return REVIEW_MODES.includes(value.mode as ReviewMode);
    case 'ready':
      return (
        isRecord(value.result) &&
        REVIEW_MODES.includes(value.result.mode as ReviewMode) &&
        typeof value.result.base === 'string' &&
        Array.isArray(value.result.files) &&
        value.result.files.length <= MAX_REVIEW_FILES &&
        typeof value.result.truncated === 'boolean'
      );
    case 'unavailable':
      return (
        REVIEW_MODES.includes(value.mode as ReviewMode) &&
        typeof value.problem === 'string' &&
        typeof value.message === 'string'
      );
    default:
      return false;
  }
}

/**
 * Ids of the graph nodes touched by a review: the touched functions, plus
 * each file whose top-level code changed or that is new.
 *
 * @param result - Review result.
 * @param fileIdOf - Graph id of a file path.
 * @returns The ids.
 */
export function changedNodeIds(
  result: ReviewResult,
  fileIdOf: (filePath: RelPath) => string,
): Set<string> {
  const ids = new Set<string>();
  for (const file of result.files) {
    if (!file.inGraph) {
      continue;
    }
    if (file.topLevel || file.status === 'added') {
      ids.add(fileIdOf(file.filePath));
    }
    for (const fn of file.functions) {
      ids.add(fn.nodeId);
    }
  }
  return ids;
}
