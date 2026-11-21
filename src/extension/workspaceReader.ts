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
import { GitignoreFilter, buildExcludeGlob } from './exclusions';
import type { WorkspaceReader } from './graphService';

/** Glob of `.gitignore` files. */
const GITIGNORE_GLOB = '**/.gitignore';

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
   * Creates a reader rooted at a workspace folder.
   *
   * @param root - URI of the workspace folder that relative paths refer to.
   */
  public constructor(private readonly root: vscode.Uri) {}

  /**
   * Lists source files under the root, leaving out excluded directories,
   * `files.exclude` matches and `.gitignore`d files. Also refreshes the
   * `.gitignore` rules used by {@link isIncluded}.
   *
   * @returns Workspace-relative POSIX paths.
   */
  public async listFiles(): Promise<RelPath[]> {
    const exclude = this.excludePattern();
    const [uris, gitignore] = await Promise.all([
      vscode.workspace.findFiles(new vscode.RelativePattern(this.root, SOURCE_GLOB), exclude),
      this.loadGitignore(exclude),
    ]);
    this.gitignore = gitignore;
    return uris
      .map((uri) => this.toRelPath(uri))
      .filter((path): path is RelPath => path !== null && !gitignore.isIgnored(path));
  }

  /**
   * Lists the source files inside a folder, with the same rules as {@link listFiles}.
   *
   * @param folder - Folder to search (e.g. a folder that was just created).
   * @returns Workspace-relative POSIX paths.
   */
  public async listFilesIn(folder: vscode.Uri): Promise<RelPath[]> {
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
    const relative = posix.relative(this.root.path, uri.path);
    if (relative === '' || relative.startsWith('..') || posix.isAbsolute(relative)) {
      return null;
    }
    return toPosixPath(relative);
  }

  /**
   * Builds the exclude pattern from the built-in exclusions and the current
   * `files.exclude` setting of the folder.
   *
   * @returns Pattern relative to the root.
   */
  private excludePattern(): vscode.RelativePattern {
    const filesExclude = vscode.workspace
      .getConfiguration('files', this.root)
      .get<Record<string, unknown>>('exclude');
    return new vscode.RelativePattern(this.root, buildExcludeGlob(filesExclude));
  }

  /**
   * Reads every `.gitignore` of the workspace. Unreadable files are skipped.
   *
   * @param exclude - Exclude pattern (so `.gitignore`s in `node_modules` are ignored).
   * @returns The compiled filter.
   */
  private async loadGitignore(exclude: vscode.RelativePattern): Promise<GitignoreFilter> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.root, GITIGNORE_GLOB),
      exclude,
    );
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
