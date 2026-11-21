/**
 * Keeps the graph in sync with the workspace: saves, external edits, created
 * and deleted files (including whole folders).
 */
import * as vscode from 'vscode';

import type { GraphPatch, RelPath } from '../shared';
import { SOURCE_GLOB, isAnalyzableFile } from './analyzer/config';
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
        this.enqueue(uri, 'update');
      }),
      watcher.onDidDelete((uri) => {
        this.handleDeleted(uri);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.enqueue(document.uri, 'update');
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
   * Schedules a change for an analyzable file.
   *
   * @param uri - URI reported by VS Code.
   * @param kind - What happened to the file.
   */
  private enqueue(uri: vscode.Uri, kind: FileChangeKind): void {
    const filePath = this.reader.toRelPath(uri);
    if (filePath !== null && isAnalyzableFile(filePath)) {
      this.scheduler.schedule(filePath, kind);
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
      this.scheduler.schedule(createdPath, 'update');
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.Directory) {
        return;
      }
      const files = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, SOURCE_GLOB));
      for (const file of files) {
        this.enqueue(file, 'update');
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
    return this.service
      .getSnapshot()
      .nodes.filter((node) => node.kind === 'file' && node.filePath.startsWith(prefix))
      .map((node) => node.filePath);
  }

  /**
   * Applies a debounced change to the graph and forwards the patch.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param kind - What happened to the file.
   */
  private async applyChange(filePath: RelPath, kind: FileChangeKind): Promise<void> {
    if (this.service.getSnapshot().version === 0) {
      return; // The initial scan has not run yet; it will pick the change up.
    }
    try {
      const patch =
        kind === 'remove'
          ? await this.service.removeFile(filePath)
          : await this.service.updateFile(filePath);
      if (patch !== null) {
        this.logger.info(`Graph updated for "${filePath}" (${kind}, v${String(patch.version)}).`);
        this.onPatch(patch);
      }
    } catch (error) {
      this.logger.error(`Could not apply ${kind} of "${filePath}": ${describeError(error)}`);
    }
  }
}
