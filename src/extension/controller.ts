/**
 * Coordinates the graph service, the workspace reader and the webview panel.
 */
import * as vscode from 'vscode';

import type { HostToWebview, RelPath, WebviewToHost } from '../shared';
import { GraphService } from './graphService';
import { openFileAtLine } from './navigation';
import { CodeGraphPanel } from './panel';
import { VsCodeWorkspaceReader } from './workspaceReader';

/** Analysis resources bound to one workspace folder. */
interface AnalysisSession {
  readonly folder: vscode.WorkspaceFolder;
  readonly reader: VsCodeWorkspaceReader;
  readonly service: GraphService;
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
 * Entry point of CodeGraph features: opens the panel, answers webview
 * requests and keeps one analysis session per workspace folder.
 */
export class CodeGraphController implements vscode.Disposable {
  private panel: CodeGraphPanel | undefined;
  private session: AnalysisSession | undefined;

  /**
   * Creates the controller.
   *
   * @param extensionUri - Root URI of the extension (to locate the webview bundle).
   * @param logger - Extension log channel.
   */
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: vscode.LogOutputChannel,
  ) {}

  /**
   * Shows the graph panel, creating it if needed. The analysis starts when the
   * webview reports it is ready.
   */
  public openGraph(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      void vscode.window.showWarningMessage('CodeGraph: open a folder to analyze.');
      return;
    }
    this.ensureSession(folder);

    if (this.panel !== undefined) {
      this.panel.reveal();
      return;
    }
    this.panel = CodeGraphPanel.create(
      this.extensionUri,
      (message) => {
        void this.handleMessage(message);
      },
      () => {
        this.panel = undefined;
      },
      this.logger,
    );
  }

  /** Closes the panel and releases resources. */
  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.session = undefined;
  }

  /**
   * Returns the session of a folder, creating a new one if the folder changed.
   *
   * @param folder - Workspace folder to analyze.
   * @returns The active session.
   */
  private ensureSession(folder: vscode.WorkspaceFolder): AnalysisSession {
    if (this.session?.folder.uri.toString() !== folder.uri.toString()) {
      const reader = new VsCodeWorkspaceReader(folder.uri);
      this.session = { folder, reader, service: new GraphService(reader, this.logger) };
      this.logger.info(`Analysis session created for "${folder.name}".`);
    }
    return this.session;
  }

  /**
   * Dispatches a validated webview message.
   *
   * @param message - Message received from the webview.
   */
  private async handleMessage(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendGraph(false);
        return;
      case 'refresh':
        await this.sendGraph(true);
        return;
      case 'navigate':
        await this.navigate(message.filePath, message.line);
        return;
    }
  }

  /**
   * Sends the full graph to the webview, scanning the workspace if needed.
   *
   * @param forceRescan - Rescan even if a graph is already available.
   */
  private async sendGraph(forceRescan: boolean): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    const current = session.service.getSnapshot();
    if (!forceRescan && current.version > 0) {
      await this.post({ type: 'graph/init', graph: current });
      return;
    }

    await this.post({ type: 'status', state: 'analyzing' });
    const startedAt = Date.now();
    try {
      const graph = await session.service.initialize();
      this.logger.info(`Graph sent to webview after ${String(Date.now() - startedAt)} ms.`);
      await this.post({ type: 'graph/init', graph });
    } catch (error) {
      const message = describeError(error);
      this.logger.error(`Graph build failed: ${message}`);
      await this.post({ type: 'status', state: 'error', message });
    }
  }

  /**
   * Opens a workspace file at a line, in a column different from the panel's.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param line - 1-based line.
   */
  private async navigate(filePath: RelPath, line: number): Promise<void> {
    if (this.session === undefined) {
      return;
    }
    const viewColumn =
      this.panel?.viewColumn === vscode.ViewColumn.One
        ? vscode.ViewColumn.Beside
        : vscode.ViewColumn.One;
    try {
      await openFileAtLine(this.session.reader.toUri(filePath), line, viewColumn);
    } catch (error) {
      const message = describeError(error);
      this.logger.error(`Could not open "${filePath}": ${message}`);
      void vscode.window.showErrorMessage(`CodeGraph: could not open ${filePath} — ${message}`);
    }
  }

  /**
   * Sends a message to the panel if it is open.
   *
   * @param message - Message to deliver.
   */
  private async post(message: HostToWebview): Promise<void> {
    await this.panel?.post(message);
  }
}
