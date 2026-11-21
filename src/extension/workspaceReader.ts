/**
 * VS Code implementation of the {@link WorkspaceReader} port.
 */
import { posix } from 'node:path';

import * as vscode from 'vscode';

import type { RelPath } from '../shared';
import { toPosixPath } from '../shared';
import { EXCLUDE_GLOB, SOURCE_GLOB } from './analyzer/config';
import type { WorkspaceReader } from './graphService';

/** Reads workspace files through `vscode.workspace` (async, remote-friendly). */
export class VsCodeWorkspaceReader implements WorkspaceReader {
  private readonly decoder = new TextDecoder('utf-8');

  /**
   * Creates a reader rooted at a workspace folder.
   *
   * @param root - URI of the workspace folder that relative paths refer to.
   */
  public constructor(private readonly root: vscode.Uri) {}

  /**
   * Lists source files under the root, excluding ignored directories.
   *
   * @returns Workspace-relative POSIX paths.
   */
  public async listFiles(): Promise<RelPath[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.root, SOURCE_GLOB),
      new vscode.RelativePattern(this.root, EXCLUDE_GLOB),
    );
    return uris.map((uri) => this.toRelPath(uri)).filter((path): path is RelPath => path !== null);
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
}
