/**
 * Keeps the graph in sync with the workspace: saves, external edits, created
 * and deleted files (including whole folders).
 */
import * as vscode from 'vscode';

import type { GraphPatch, RelPath } from '../shared';
import { isAnalyzableFile } from './analyzer/config';
import type { FileChangeKind } from './changeScheduler';
import { ChangeScheduler } from './changeScheduler';
import type { GraphService } from './graphService';
import type { VsCodeWorkspaceReader } from './workspaceReader';

/** Logging surface used by the sync. */
interface SyncLogger {
  /** Logs an informational message. */
  info(message: string): void;
  /** Logs a failure. */
  error(message: string): void;
}

/**
 * Converts an unknown thrown value into a readable message.
 *
 * @param error - Caught value.
 * @returns The error message.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Listens to workspace events, debounces them per file and forwards the
 * resulting graph patches.
 */
export class WorkspaceSync implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly scheduler: ChangeScheduler;
  /** Changes coalesced into one batch share a patch; it is forwarded once. */
  private lastForwardedVersion = 0;

  /**
   * Starts listening to the workspace.
   *
   * @param root - Workspace folder being analyzed.
   * @param reader - Converts between URIs and workspace-relative paths.
   * @param service - Graph service that applies the changes.
   * @param onPatch - Receives every non-empty patch.
   * @param logger - Destination of diagnostic messages.
   */
  public constructor(
    root: vscode.Uri,
    private readonly reader: VsCodeWorkspaceReader,
    private readonly service: GraphService,
    private readonly onPatch: (patch: GraphPatch) => void,
    private readonly logger: SyncLogger,
  ) {
    this.scheduler = new ChangeScheduler((filePath, kind) => {
      void this.applyChange(filePath, kind);
    });

    // Watch every path (not only source files) so folder deletions and
    // creations are reported too.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '**'),
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => {
        void this.handleCreated(uri);
      }),
      watcher.onDidChange((uri) => {
        void this.enqueueUpdate(uri);
      }),
      watcher.onDidDelete((uri) => {
        this.handleDeleted(uri);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.enqueueUpdate(document.uri);
      }),
      new vscode.Disposable(() => {
        this.scheduler.dispose();
      }),
    );
  }

  /** Stops listening and cancels pending changes. */
  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /**
   * Schedules an update for a file of the graph, or for a new file that is
   * not excluded (`files.exclude`, `.gitignore`).
   *
   * @param uri - URI reported by VS Code.
   */
  private async enqueueUpdate(uri: vscode.Uri): Promise<void> {
    const filePath = this.reader.toRelPath(uri);
    if (filePath === null || !isAnalyzableFile(filePath)) {
      return;
    }
    try {
      if (this.service.hasFile(filePath) || (await this.reader.isIncluded(filePath))) {
        this.scheduler.schedule(filePath, 'update');
      }
    } catch (error) {
      this.logger.error(`Could not check "${filePath}": ${describeError(error)}`);
    }
  }

  /**
   * Handles a created path: a source file, or a folder whose source files
   * must all be added (VS Code reports only the folder).
   *
   * @param uri - Created path.
   */
  private async handleCreated(uri: vscode.Uri): Promise<void> {
    const createdPath = this.reader.toRelPath(uri);
    if (createdPath === null) {
      return;
    }
    if (isAnalyzableFile(createdPath)) {
      await this.enqueueUpdate(uri);
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.Directory) {
        return;
      }
      for (const filePath of await this.reader.listFilesIn(uri)) {
        this.scheduler.schedule(filePath, 'update');
      }
    } catch (error) {
      this.logger.error(`Could not inspect created path "${createdPath}": ${describeError(error)}`);
    }
  }

  /**
   * Handles a deleted path: a source file, or a folder whose known files must
   * all be removed (VS Code reports only the folder).
   *
   * @param uri - Deleted path.
   */
  private handleDeleted(uri: vscode.Uri): void {
    const deletedPath = this.reader.toRelPath(uri);
    if (deletedPath === null) {
      return;
    }
    if (isAnalyzableFile(deletedPath)) {
      this.scheduler.schedule(deletedPath, 'remove');
      return;
    }
    for (const filePath of this.findKnownFilesUnder(deletedPath)) {
      this.scheduler.schedule(filePath, 'remove');
    }
  }

  /**
   * Lists the files of the current graph located under a folder.
   *
   * @param folderPath - Workspace-relative folder path.
   * @returns Paths of the graph's files inside that folder.
   */
  private findKnownFilesUnder(folderPath: RelPath): RelPath[] {
    const prefix = `${folderPath}/`;
    return this.service.getFilePaths().filter((filePath) => filePath.startsWith(prefix));
  }

  /**
   * Applies a debounced change to the graph and forwards the patch.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param kind - What happened to the file.
   */
  private async applyChange(filePath: RelPath, kind: FileChangeKind): Promise<void> {
    if (!this.service.hasScanned) {
      return; // The initial scan has not run yet; it will pick the change up.
    }
    try {
      const patch =
        kind === 'remove'
          ? await this.service.removeFile(filePath)
          : await this.service.updateFile(filePath);
      if (patch !== null && patch.version > this.lastForwardedVersion) {
        this.lastForwardedVersion = patch.version;
        this.logger.info(
          `Graph updated (v${String(patch.version)}, batch including ${kind} of "${filePath}").`,
        );
        this.onPatch(patch);
      }
    } catch (error) {
      this.logger.error(`Could not apply ${kind} of "${filePath}": ${describeError(error)}`);
    }
  }
}
