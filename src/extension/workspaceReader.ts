/**
 * VS Code implementation of the {@link WorkspaceReader} port.
 */
import { posix } from 'node:path';

import * as vscode from 'vscode';

import type { RelPath } from '../shared';
import { toPosixPath } from '../shared';
import { SOURCE_GLOB, isAnalyzableFile } from './analyzer/config';
import type { FileStamp } from './cache';
import type { GitignoreFile } from './exclusions';
import { GitignoreFilter, buildExcludeGlob, createExcludeMatcher } from './exclusions';
import { relativeUriPath } from './rootPaths';
import type { WorkspaceReader } from './graphService';

/** Glob of `.gitignore` files. */
const GITIGNORE_GLOB = '**/.gitignore';

/** Folders read at once while walking a folder without `findFiles`. */
const WALK_BATCH_SIZE = 64;

/** Files and folders found by {@link VsCodeWorkspaceReader.walk}. */
interface WalkResult {
  /** Analyzable, non-excluded source files (workspace-relative). */
  readonly sources: RelPath[];
  /** `.gitignore` files. */
  readonly gitignores: vscode.Uri[];
}

/** Characters with a special meaning in globs. */
const GLOB_SPECIAL_CHARACTERS = /[[\]{}*?!,]/;

/**
 * Reads workspace files through `vscode.workspace` (async, remote-friendly)
 * and applies the user's exclusions: `files.exclude` and `.gitignore`.
 */
export class VsCodeWorkspaceReader implements WorkspaceReader {
  private readonly decoder = new TextDecoder('utf-8');
  private gitignore = GitignoreFilter.EMPTY;
  /**
   * Whether the folder is listed by walking it, because `findFiles` returned
   * nothing for a folder that has source files (seen with some VS Code builds
   * and file systems).
   */
  private walking = false;

  /**
   * Creates a reader rooted at a workspace folder.
   *
   * @param root - URI of the workspace folder that relative paths refer to.
   * @param onNotice - Receives diagnostic messages (e.g. the fallback listing).
   */
  public constructor(
    private readonly root: vscode.Uri,
    private readonly onNotice: (message: string) => void = () => undefined,
  ) {}

  /**
   * Lists source files under the root, leaving out excluded directories,
   * `files.exclude` matches and `.gitignore`d files. Also refreshes the
   * `.gitignore` rules used by {@link isIncluded}.
   *
   * Uses `workspace.findFiles` (fast, ripgrep-based); when it finds nothing,
   * the folder is walked directly, so a failing file search never yields an
   * empty graph.
   *
   * @returns Workspace-relative POSIX paths.
   */
  public async listFiles(): Promise<RelPath[]> {
    const exclude = this.excludePattern();
    const [uris, gitignoreUris] = await Promise.all([
      vscode.workspace.findFiles(new vscode.RelativePattern(this.root, SOURCE_GLOB), exclude),
      vscode.workspace.findFiles(new vscode.RelativePattern(this.root, GITIGNORE_GLOB), exclude),
    ]);
    const found = uris
      .map((uri) => this.toRelPath(uri))
      .filter((path): path is RelPath => path !== null);
    if (found.length > 0) {
      this.walking = false;
      const gitignore = await this.loadGitignore(gitignoreUris);
      this.gitignore = gitignore;
      return found.filter((path) => !gitignore.isIgnored(path));
    }
    const [unmapped] = uris;
    const reason =
      unmapped === undefined
        ? 'File search returned no files'
        : `File search returned ${String(uris.length)} files outside the folder (e.g. ${unmapped.toString(true)})`;
    const walked = await this.walk(this.root);
    this.walking = walked.sources.length > 0;
    this.onNotice(
      `${reason} for ${this.root.toString(true)}; listed the folder directly instead (${String(walked.sources.length)} source files).`,
    );
    const gitignore = await this.loadGitignore(walked.gitignores);
    this.gitignore = gitignore;
    return walked.sources.filter((path) => !gitignore.isIgnored(path));
  }

  /**
   * Lists the source files inside a folder, with the same rules as {@link listFiles}.
   *
   * @param folder - Folder to search (e.g. a folder that was just created).
   * @returns Workspace-relative POSIX paths.
   */
  public async listFilesIn(folder: vscode.Uri): Promise<RelPath[]> {
    if (this.walking) {
      const walked = await this.walk(folder);
      return walked.sources.filter((path) => !this.gitignore.isIgnored(path));
    }
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, SOURCE_GLOB),
      this.excludePattern(),
    );
    return uris
      .map((uri) => this.toRelPath(uri))
      .filter(
        (path): path is RelPath =>
          path !== null && isAnalyzableFile(path) && !this.gitignore.isIgnored(path),
      );
  }

  /**
   * Checks whether a file that is not in the graph yet (created, or saved for
   * the first time) should be analyzed, using the same rules as {@link listFiles}.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns `true` if the file is analyzable and not excluded.
   */
  public async isIncluded(filePath: RelPath): Promise<boolean> {
    if (!isAnalyzableFile(filePath) || this.gitignore.isIgnored(filePath)) {
      return false;
    }
    if (this.walking) {
      return !createExcludeMatcher(this.filesExclude())(filePath);
    }
    const name = posix.basename(filePath);
    if (GLOB_SPECIAL_CHARACTERS.test(name)) {
      return true; // Cannot be matched literally; `files.exclude` is checked on the next scan.
    }
    // `findFiles` applies the exclude glob, so asking for this exact file
    // tells whether `files.exclude` hides it.
    const directory = posix.dirname(filePath);
    const base = directory === '.' ? this.root : this.toUri(directory);
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(base, name),
      this.excludePattern(),
      1,
    );
    return found.length > 0;
  }

  /**
   * Reads a file as UTF-8 text.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The file content.
   */
  public async readFile(filePath: RelPath): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(this.toUri(filePath));
    return this.decoder.decode(bytes);
  }

  /**
   * Returns the modification time and size of a file.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The file stamp.
   */
  public async stat(filePath: RelPath): Promise<FileStamp> {
    const stat = await vscode.workspace.fs.stat(this.toUri(filePath));
    return { mtime: stat.mtime, size: stat.size };
  }

  /**
   * Converts a workspace-relative path into a URI.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The absolute file URI.
   */
  public toUri(filePath: RelPath): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...filePath.split('/'));
  }

  /**
   * Converts a URI into a workspace-relative path.
   *
   * @param uri - File URI.
   * @returns The relative POSIX path, or `null` if the URI is outside the root
   *   or uses a different scheme/authority.
   */
  public toRelPath(uri: vscode.Uri): RelPath | null {
    if (uri.scheme !== this.root.scheme || uri.authority !== this.root.authority) {
      return null;
    }
    const relative = relativeUriPath(this.root.path, uri.path);
    return relative === null ? null : toPosixPath(relative);
  }

  /**
   * Builds the exclude pattern from the built-in exclusions and the current
   * `files.exclude` setting of the folder.
   *
   * @returns Pattern relative to the root.
   */
  private excludePattern(): vscode.RelativePattern {
    return new vscode.RelativePattern(this.root, buildExcludeGlob(this.filesExclude()));
  }

  /**
   * Reads the `files.exclude` setting of the folder.
   *
   * @returns The setting value, if any.
   */
  private filesExclude(): Record<string, unknown> | undefined {
    return vscode.workspace
      .getConfiguration('files', this.root)
      .get<Record<string, unknown>>('exclude');
  }

  /**
   * Lists the source and `.gitignore` files under a folder by reading its
   * directories (no file search). Excluded folders are not entered and
   * symbolic links to folders are not followed.
   *
   * @param folder - Folder to walk.
   * @returns The files found.
   */
  private async walk(folder: vscode.Uri): Promise<WalkResult> {
    const isExcluded = createExcludeMatcher(this.filesExclude());
    const result: WalkResult = { sources: [], gitignores: [] };
    const pending = [folder];
    while (pending.length > 0) {
      const batch = pending.splice(0, WALK_BATCH_SIZE);
      const listings = await Promise.all(
        batch.map(async (directory) => ({ directory, entries: await readDirectory(directory) })),
      );
      for (const { directory, entries } of listings) {
        for (const [name, type] of entries) {
          const uri = vscode.Uri.joinPath(directory, name);
          const path = this.toRelPath(uri);
          if (path === null) {
            continue;
          }
          if ((type & vscode.FileType.Directory) !== 0) {
            if ((type & vscode.FileType.SymbolicLink) === 0 && !isExcluded(`${path}/`)) {
              pending.push(uri);
            }
          } else if (name === '.gitignore') {
            result.gitignores.push(uri);
          } else if (isAnalyzableFile(path) && !isExcluded(path)) {
            result.sources.push(path);
          }
        }
      }
    }
    return result;
  }

  /**
   * Reads `.gitignore` files. Unreadable files are skipped.
   *
   * @param uris - The `.gitignore` files of the workspace.
   * @returns The compiled filter.
   */
  private async loadGitignore(uris: readonly vscode.Uri[]): Promise<GitignoreFilter> {
    const files = await Promise.all(
      uris.map(async (uri): Promise<GitignoreFile | null> => {
        const filePath = this.toRelPath(uri);
        if (filePath === null) {
          return null;
        }
        try {
          const content = this.decoder.decode(await vscode.workspace.fs.readFile(uri));
          const directory = posix.dirname(filePath);
          return { directory: directory === '.' ? '' : directory, content };
        } catch {
          return null;
        }
      }),
    );
    return new GitignoreFilter(files.filter((file): file is GitignoreFile => file !== null));
  }
}

/**
 * Reads a directory, treating an unreadable one as empty.
 *
 * @param directory - Directory URI.
 * @returns Its entries (name and type).
 */
async function readDirectory(directory: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(directory);
  } catch {
    return [];
  }
}
