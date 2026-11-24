/**
 * Reads the files of every workspace folder as one workspace: with several
 * folders open, each folder's files appear under a top-level folder named
 * after it (see `rootPaths.ts`); with one folder, paths are unchanged.
 */
import type * as vscode from 'vscode';

import type { RelPath } from '../shared';
import type { FileStamp } from './cache';
import type { WorkspaceReader } from './graphService';
import {
  addRootPrefix,
  assignRootPrefixes,
  findContainingRoot,
  splitRootPrefix,
} from './rootPaths';
import { VsCodeWorkspaceReader } from './workspaceReader';

/** Files of the workspace as the extension sees them (one or several folders). */
export interface WorkspaceFiles extends WorkspaceReader {
  /** Lists the analyzable files under a folder (e.g. a folder just created). */
  listFilesIn(folder: vscode.Uri): Promise<RelPath[]>;
  /** Tells whether a file is analyzed (not excluded by settings or `.gitignore`). */
  isIncluded(filePath: RelPath): Promise<boolean>;
  /** Stamps a file (modification time and size). */
  stat(filePath: RelPath): Promise<FileStamp>;
  /** Converts a workspace path into a URI. */
  toUri(filePath: RelPath): vscode.Uri;
  /** Converts a URI into a workspace path, or `null` outside the workspace. */
  toRelPath(uri: vscode.Uri): RelPath | null;
}

/** One workspace folder with its reader. */
interface Root {
  readonly prefix: string;
  readonly uri: vscode.Uri;
  readonly reader: VsCodeWorkspaceReader;
}

/**
 * Reader over every workspace folder. Nested folders (a folder and one of its
 * subfolders both opened) are read once, under the deepest folder.
 */
export class MultiRootWorkspaceReader implements WorkspaceFiles {
  private readonly roots: readonly Root[];
  private readonly prefixes: readonly string[];

  /**
   * Creates the reader.
   *
   * @param folders - Workspace folders, in workspace order.
   * @param onNotice - Receives diagnostic messages of the folder readers.
   */
  public constructor(
    folders: readonly { readonly name: string; readonly uri: vscode.Uri }[],
    onNotice?: (message: string) => void,
  ) {
    this.prefixes = assignRootPrefixes(folders.map((folder) => folder.name));
    this.roots = folders.map((folder, index) => ({
      prefix: this.prefixes[index] ?? '',
      uri: folder.uri,
      reader: new VsCodeWorkspaceReader(folder.uri, onNotice),
    }));
  }

  /** URIs of the folders, as watched by the workspace sync. */
  public get rootUris(): readonly vscode.Uri[] {
    return this.roots.map((root) => root.uri);
  }

  /**
   * Lists the analyzable files of every folder.
   *
   * @returns Workspace paths, each file once.
   */
  public async listFiles(): Promise<RelPath[]> {
    const lists = await Promise.all(
      this.roots.map(async (root) => ({ root, files: await root.reader.listFiles() })),
    );
    return this.keepOwnFiles(lists);
  }

  /**
   * Lists the analyzable files under a folder.
   *
   * @param folder - Folder URI.
   * @returns Workspace paths.
   */
  public async listFilesIn(folder: vscode.Uri): Promise<RelPath[]> {
    const root = this.rootOf(folder);
    if (root === undefined) {
      return [];
    }
    return this.keepOwnFiles([{ root, files: await root.reader.listFilesIn(folder) }]);
  }

  /**
   * Tells whether a file is analyzed.
   *
   * @param filePath - Workspace path.
   * @returns `false` when excluded or outside the workspace.
   */
  public async isIncluded(filePath: RelPath): Promise<boolean> {
    const located = this.locate(filePath);
    return located === null ? false : located.root.reader.isIncluded(located.path);
  }

  /**
   * Reads a file.
   *
   * @param filePath - Workspace path.
   * @returns Its text.
   * @throws Error when the path is outside the workspace or cannot be read.
   */
  public async readFile(filePath: RelPath): Promise<string> {
    const located = this.requireLocation(filePath);
    return located.root.reader.readFile(located.path);
  }

  /**
   * Stamps a file.
   *
   * @param filePath - Workspace path.
   * @returns Modification time and size.
   * @throws Error when the path is outside the workspace or cannot be read.
   */
  public async stat(filePath: RelPath): Promise<FileStamp> {
    const located = this.requireLocation(filePath);
    return located.root.reader.stat(located.path);
  }

  /**
   * Converts a workspace path into a URI.
   *
   * @param filePath - Workspace path.
   * @returns The URI.
   * @throws Error when the path is outside the workspace.
   */
  public toUri(filePath: RelPath): vscode.Uri {
    const located = this.requireLocation(filePath);
    return located.root.reader.toUri(located.path);
  }

  /**
   * Converts a URI into a workspace path.
   *
   * @param uri - File or folder URI.
   * @returns The workspace path, or `null` outside every folder.
   */
  public toRelPath(uri: vscode.Uri): RelPath | null {
    const root = this.rootOf(uri);
    const path = root?.reader.toRelPath(uri) ?? null;
    return root === undefined || path === null ? null : addRootPrefix(root.prefix, path);
  }

  /**
   * Finds the deepest folder that contains a URI.
   *
   * @param uri - URI.
   * @returns The folder, or `undefined`.
   */
  private rootOf(uri: vscode.Uri): Root | undefined {
    const [only] = this.roots;
    if (this.roots.length === 1 && only !== undefined) {
      // One folder: its reader decides (same checks as before multi-root support).
      const inside = uri.toString() === only.uri.toString() || only.reader.toRelPath(uri) !== null;
      return inside ? only : undefined;
    }
    const candidates = this.roots.filter(
      (root) => root.uri.scheme === uri.scheme && root.uri.authority === uri.authority,
    );
    const index = findContainingRoot(
      uri.path,
      candidates.map((root) => root.uri.path),
    );
    return candidates[index];
  }

  /**
   * Keeps the files that belong to the folder they were listed from (a file of
   * a nested folder is listed by both) and prefixes them.
   *
   * @param lists - Files listed by each folder (folder-relative paths).
   * @returns Workspace paths.
   */
  private keepOwnFiles(
    lists: readonly { readonly root: Root; readonly files: readonly RelPath[] }[],
  ): RelPath[] {
    const nested = this.roots.length > 1;
    return lists.flatMap(({ root, files }) =>
      files
        .filter((file) => !nested || this.rootOf(root.reader.toUri(file)) === root)
        .map((file) => addRootPrefix(root.prefix, file)),
    );
  }

  /**
   * Finds the folder of a workspace path.
   *
   * @param filePath - Workspace path.
   * @returns The folder and the folder-relative path, or `null`.
   */
  private locate(filePath: RelPath): { readonly root: Root; readonly path: RelPath } | null {
    const split = splitRootPrefix(filePath, this.prefixes);
    const root = split === null ? undefined : this.roots[split.index];
    return root === undefined || split === null ? null : { root, path: split.path };
  }

  /**
   * Finds the folder of a workspace path or throws.
   *
   * @param filePath - Workspace path.
   * @returns The folder and the folder-relative path.
   * @throws Error when the path is outside the workspace.
   */
  private requireLocation(filePath: RelPath): { readonly root: Root; readonly path: RelPath } {
    const located = this.locate(filePath);
    if (located === null) {
      throw new Error(`"${filePath}" is not in a workspace folder.`);
    }
    return located;
  }
}
