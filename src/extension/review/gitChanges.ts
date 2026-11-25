/**
 * Reads the changes of the working tree from VS Code's built-in Git
 * extension (no git process of our own, no shell).
 */
import type { RelPath, ReviewFileStatus, ReviewMode, ReviewProblem } from '../../shared';
import { MAX_REVIEW_FILES } from '../../shared';
import type { FileChange } from './changeMapper';
import { parseUnifiedDiff } from './diffParser';

/** URI as used by the Git extension (a `vscode.Uri`). */
export interface GitUri {
  readonly fsPath: string;
  toString(): string;
}

/** A changed file reported by the Git extension. */
export interface GitChange {
  readonly uri: GitUri;
  readonly originalUri: GitUri;
  readonly renameUri: GitUri | undefined;
  /** `Status` enum of the Git extension. */
  readonly status: number;
}

/** Subset of the Git extension's `Repository` used here. */
export interface GitRepository {
  readonly rootUri: GitUri;
  readonly state: {
    readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
    readonly workingTreeChanges: readonly GitChange[];
    readonly untrackedChanges?: readonly GitChange[];
  };
  diffWith(ref: string): Promise<GitChange[]>;
  diffWith(ref: string, path: string): Promise<string>;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  getCommit(ref: string): Promise<{ readonly hash: string }>;
  getBranches(query: { readonly remote?: boolean }): Promise<readonly GitRef[]>;
}

/** A branch reported by the Git extension (`Ref`). */
export interface GitRef {
  readonly name?: string;
  /** `RefType`: 0 local branch, 1 remote branch, 2 tag. */
  readonly type: number;
  readonly remote?: string;
}

/** Subset of the Git extension's API (version 1) used here. */
export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  getRepository(uri: GitUri): GitRepository | null;
}

/** Workspace access needed to map git paths to graph paths. */
export interface ReviewWorkspace {
  /** Root folders of the analysis. */
  readonly roots: readonly GitUri[];
  /** Graph path of a file, or `null` outside the analyzed folders. */
  toRelPath(uri: GitUri): RelPath | null;
  /** Reads a file of the workspace (to count the lines of untracked files). */
  readFile(filePath: RelPath): Promise<string>;
}

/** Changes found in the workspace. */
export interface CollectedChanges {
  /** What was compared with, e.g. `main · 1a2b3c4`. */
  readonly base: string;
  readonly changes: readonly FileChange[];
  readonly truncated: boolean;
}

/** A review that cannot be computed, with a reason the webview can show. */
export class ReviewError extends Error {
  /**
   * Creates the error.
   *
   * @param problem - Kind of problem.
   * @param message - Text for the user.
   */
  public constructor(
    public readonly problem: ReviewProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

/** Branches tried, in order, when no base branch is configured. */
export const DEFAULT_BASE_BRANCHES: readonly string[] = [
  'main',
  'master',
  'origin/main',
  'origin/master',
  'develop',
];

/** Most branches offered in the base branch picker. */
export const MAX_LISTED_BRANCHES = 200;

/**
 * Lists the branches a review can compare with: local branches first, then
 * remote ones, without the current branch and remote `HEAD` aliases.
 *
 * @param git - Git extension API.
 * @param roots - Root folders of the analysis.
 * @returns Branch names (empty without repository).
 */
export async function listBranches(git: GitApi, roots: readonly GitUri[]): Promise<string[]> {
  const repository = roots
    .map((root) => git.getRepository(root))
    .find((found): found is GitRepository => found !== null);
  if (repository === undefined) {
    return [];
  }
  const current = repository.state.HEAD?.name;
  const refs = await repository.getBranches({ remote: true });
  /**
   * Sorted branch names of one kind.
   *
   * @param type - `RefType` (0 local, 1 remote).
   * @returns The names.
   */
  const names = (type: number): string[] =>
    refs
      .filter((ref) => ref.type === type && ref.name !== undefined)
      .map((ref) => ref.name ?? '')
      .filter((name) => name !== current && !name.endsWith('/HEAD'))
      .sort((a, b) => a.localeCompare(b));
  return [...new Set([...names(0), ...names(1)])].slice(0, MAX_LISTED_BRANCHES);
}

/** Diffs read at the same time. */
const DIFF_CONCURRENCY = 6;

/** `Status` values of the Git extension that mean a new file. */
const ADDED_STATUSES = new Set([1, 4, 7, 9, 16]);
/** `Status` values that mean a deleted file. */
const DELETED_STATUSES = new Set([2, 6, 14, 15, 17]);
/** `Status` values that mean a renamed file. */
const RENAMED_STATUSES = new Set([3, 10]);
/** `Status` of an untracked file. */
const UNTRACKED_STATUS = 7;

/**
 * Converts a Git extension status to a review status.
 *
 * @param status - `Status` enum value.
 * @returns The review status.
 */
export function toReviewStatus(status: number): ReviewFileStatus {
  if (ADDED_STATUSES.has(status)) {
    return 'added';
  }
  if (DELETED_STATUSES.has(status)) {
    return 'deleted';
  }
  return RENAMED_STATUSES.has(status) ? 'renamed' : 'modified';
}

/**
 * Short form of a commit hash.
 *
 * @param hash - Full hash.
 * @returns Its first 7 characters.
 */
function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/**
 * Checks whether a ref exists.
 *
 * @param repository - Repository.
 * @param ref - Branch, tag or revision.
 * @returns Its commit hash, or `null` when it does not exist.
 */
async function commitOf(repository: GitRepository, ref: string): Promise<string | null> {
  try {
    return (await repository.getCommit(ref)).hash;
  } catch {
    return null;
  }
}

/**
 * Finds the revision the working tree is compared with.
 *
 * @param repository - Repository.
 * @param mode - Review mode.
 * @param baseBranch - Configured base branch, or empty to detect it.
 * @returns The revision and its label.
 * @throws {ReviewError} When the revision does not exist.
 */
export async function resolveBase(
  repository: GitRepository,
  mode: ReviewMode,
  baseBranch: string,
): Promise<{ readonly ref: string; readonly label: string }> {
  const head = await commitOf(repository, 'HEAD');
  if (head === null) {
    throw new ReviewError('no-base', 'The repository has no commits yet.');
  }
  if (mode === 'uncommitted') {
    return { ref: head, label: `last commit · ${shortHash(head)}` };
  }
  if (mode === 'lastCommit') {
    const parent = await commitOf(repository, 'HEAD~1');
    if (parent === null) {
      throw new ReviewError('no-base', 'The branch has a single commit: nothing to compare with.');
    }
    return { ref: parent, label: `commit before last · ${shortHash(parent)}` };
  }
  const candidates = baseBranch.trim() === '' ? DEFAULT_BASE_BRANCHES : [baseBranch.trim()];
  for (const branch of candidates) {
    if ((await commitOf(repository, branch)) === null) {
      continue;
    }
    const mergeBase = await repository.getMergeBase('HEAD', branch);
    if (mergeBase !== undefined && mergeBase !== '') {
      return { ref: mergeBase, label: `${branch} · ${shortHash(mergeBase)}` };
    }
  }
  throw new ReviewError(
    'no-base',
    baseBranch.trim() === ''
      ? 'No main, master or develop branch found. Set "codegraph.review.baseBranch".'
      : `Branch "${baseBranch.trim()}" not found.`,
  );
}

/**
 * Runs async tasks with a concurrency limit, keeping their order.
 *
 * @param items - Inputs.
 * @param limit - Tasks running at the same time.
 * @param task - Work for one input.
 * @returns The results, in input order.
 */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  /** Takes inputs until none are left. */
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Counts the lines of a text.
 *
 * @param text - Text.
 * @returns Its number of lines (a trailing newline does not start a line).
 */
function countLines(text: string): number {
  if (text === '') {
    return 0;
  }
  const lines = text.split(/\r?\n/).length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * Reads the changes of the working tree against a base, in every repository
 * of the analyzed folders.
 *
 * @param git - Git extension API.
 * @param workspace - Analyzed folders.
 * @param mode - What to compare with.
 * @param baseBranch - Configured base branch (`base` mode), or empty to detect it.
 * @returns The changes.
 * @throws {ReviewError} Without repository or base revision.
 */
export async function collectChanges(
  git: GitApi,
  workspace: ReviewWorkspace,
  mode: ReviewMode,
  baseBranch: string,
): Promise<CollectedChanges> {
  const repositories = new Map<string, GitRepository>();
  for (const root of workspace.roots) {
    const repository = git.getRepository(root);
    if (repository !== null) {
      repositories.set(repository.rootUri.toString(), repository);
    }
  }
  if (repositories.size === 0) {
    throw new ReviewError('no-repo', 'This workspace is not a git repository.');
  }

  const labels: string[] = [];
  const pending: { repository: GitRepository; ref: string; change: GitChange; path: RelPath }[] =
    [];
  for (const repository of repositories.values()) {
    const { ref, label } = await resolveBase(repository, mode, baseBranch);
    if (!labels.includes(label)) {
      labels.push(label);
    }
    const tracked = await repository.diffWith(ref);
    const untracked =
      repository.state.untrackedChanges ??
      repository.state.workingTreeChanges.filter((change) => change.status === UNTRACKED_STATUS);
    const seen = new Set<string>();
    for (const change of [...tracked, ...untracked]) {
      const uri = change.renameUri ?? change.uri;
      const path = workspace.toRelPath(uri);
      if (path === null || seen.has(path)) {
        continue;
      }
      seen.add(path);
      pending.push({ repository, ref, change, path });
    }
  }

  const truncated = pending.length > MAX_REVIEW_FILES;
  const changes = await mapLimited(
    pending.slice(0, MAX_REVIEW_FILES),
    DIFF_CONCURRENCY,
    async ({ repository, ref, change, path }): Promise<FileChange> => {
      const status = toReviewStatus(change.status);
      if (change.status === UNTRACKED_STATUS) {
        let lineCount = 0;
        try {
          lineCount = countLines(await workspace.readFile(path));
        } catch {
          // Unreadable (binary, removed meanwhile): listed without line counts.
        }
        return { filePath: path, status, diff: null, lineCount };
      }
      const uri = change.renameUri ?? change.uri;
      const patch = await repository.diffWith(ref, uri.fsPath);
      return { filePath: path, status, diff: parseUnifiedDiff(patch) };
    },
  );
  return { base: labels.join(', '), changes, truncated };
}
