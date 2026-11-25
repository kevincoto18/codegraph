import { describe, expect, it } from 'vitest';

import type { GitApi, GitChange, GitRepository, GitUri, ReviewWorkspace } from './gitChanges';
import {
  ReviewError,
  collectChanges,
  listBranches,
  resolveBase,
  toReviewStatus,
} from './gitChanges';

/**
 * Builds a URI.
 *
 * @param path - Absolute path.
 * @returns The URI.
 */
function uri(path: string): GitUri {
  return { fsPath: path, toString: () => `file://${path}` };
}

/**
 * Builds a change.
 *
 * @param path - Absolute path.
 * @param status - Git extension status.
 * @returns The change.
 */
function change(path: string, status: number): GitChange {
  return { uri: uri(path), originalUri: uri(path), renameUri: undefined, status };
}

/** Options of {@link fakeRepository}. */
interface FakeOptions {
  readonly commits?: Readonly<Record<string, string>>;
  readonly mergeBase?: string;
  readonly tracked?: readonly GitChange[];
  readonly untracked?: readonly GitChange[];
  readonly patches?: Readonly<Record<string, string>>;
}

/**
 * Builds a fake repository rooted at `/repo`.
 *
 * @param options - Commits, changes and patches.
 * @returns The repository and the refs diffed against.
 */
function fakeRepository(options: FakeOptions): { repository: GitRepository; diffedWith: string[] } {
  const commits = options.commits ?? { HEAD: 'aaaaaaa1111', 'HEAD~1': 'bbbbbbb2222', main: 'ccc' };
  const diffedWith: string[] = [];
  const repository = {
    rootUri: uri('/repo'),
    state: {
      HEAD: { name: 'dev', commit: commits.HEAD },
      workingTreeChanges: options.untracked ?? [],
    },
    getCommit: (ref: string) => {
      const hash = commits[ref];
      return hash === undefined ? Promise.reject(new Error('bad ref')) : Promise.resolve({ hash });
    },
    getMergeBase: () => Promise.resolve(options.mergeBase ?? 'ddddddd3333'),
    getBranches: () =>
      Promise.resolve([
        { name: 'main', type: 0 },
        { name: 'dev', type: 0 },
        { name: 'feature/x', type: 0 },
        { name: 'origin/main', type: 1, remote: 'origin' },
        { name: 'origin/HEAD', type: 1, remote: 'origin' },
        { name: 'v1.0', type: 2 },
      ]),
    diffWith: (ref: string, path?: string) => {
      if (path === undefined) {
        diffedWith.push(ref);
        return Promise.resolve(options.tracked ?? []);
      }
      return Promise.resolve(options.patches?.[path] ?? '');
    },
  } as unknown as GitRepository;
  return { repository, diffedWith };
}

/**
 * Builds a workspace rooted at `/repo/app`.
 *
 * @returns The workspace.
 */
function workspace(): ReviewWorkspace {
  return {
    roots: [uri('/repo/app')],
    toRelPath: (target) =>
      target.fsPath.startsWith('/repo/app/') ? target.fsPath.slice('/repo/app/'.length) : null,
    readFile: () => Promise.resolve('a\nb\nc\n'),
  };
}

/**
 * Wraps a repository in a Git API.
 *
 * @param repository - Repository, or `null` for none.
 * @returns The API.
 */
function api(repository: GitRepository | null): GitApi {
  return { state: 'initialized', getRepository: () => repository };
}

describe('toReviewStatus', () => {
  it('maps the Git extension statuses', () => {
    expect([5, 1, 7, 6, 3].map(toReviewStatus)).toEqual([
      'modified',
      'added',
      'added',
      'deleted',
      'renamed',
    ]);
  });
});

describe('resolveBase', () => {
  it('uses the merge base with the first existing default branch', async () => {
    const { repository } = fakeRepository({ commits: { HEAD: 'h', master: 'm' } });
    await expect(resolveBase(repository, 'base', '')).resolves.toEqual({
      ref: 'ddddddd3333',
      label: 'master · ddddddd',
    });
  });

  it('compares with HEAD or its parent', async () => {
    const { repository } = fakeRepository({});
    await expect(resolveBase(repository, 'uncommitted', '')).resolves.toMatchObject({
      ref: 'aaaaaaa1111',
    });
    await expect(resolveBase(repository, 'lastCommit', '')).resolves.toMatchObject({
      ref: 'bbbbbbb2222',
    });
  });

  it('explains a missing base', async () => {
    const { repository } = fakeRepository({ commits: { HEAD: 'h' } });
    await expect(resolveBase(repository, 'base', 'release')).rejects.toThrow(
      'Branch "release" not found.',
    );
    await expect(resolveBase(repository, 'lastCommit', '')).rejects.toBeInstanceOf(ReviewError);
  });
});

describe('collectChanges', () => {
  it('reads tracked diffs and untracked files inside the analyzed folders', async () => {
    const { repository, diffedWith } = fakeRepository({
      tracked: [change('/repo/app/src/a.ts', 5), change('/repo/other/x.ts', 5)],
      untracked: [change('/repo/app/src/new.ts', 7)],
      patches: { '/repo/app/src/a.ts': '@@ -1 +1 @@\n-a\n+b' },
    });
    const result = await collectChanges(api(repository), workspace(), 'base', '');
    expect(diffedWith).toEqual(['ddddddd3333']);
    expect(result.base).toBe('main · ddddddd');
    expect(result.changes).toEqual([
      {
        filePath: 'src/a.ts',
        status: 'modified',
        diff: expect.objectContaining({ addedLines: [1], removed: 1 }) as unknown,
      },
      { filePath: 'src/new.ts', status: 'added', diff: null, lineCount: 3 },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('fails without repository', async () => {
    await expect(collectChanges(api(null), workspace(), 'base', '')).rejects.toMatchObject({
      problem: 'no-repo',
    });
  });
});

describe('listBranches', () => {
  it('lists local then remote branches, without the current one, HEAD aliases or tags', async () => {
    const { repository } = fakeRepository({});
    await expect(listBranches(api(repository), [uri('/repo/app')])).resolves.toEqual([
      'feature/x',
      'main',
      'origin/main',
    ]);
    await expect(listBranches(api(null), [uri('/repo/app')])).resolves.toEqual([]);
  });
});
