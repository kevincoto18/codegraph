/**
 * Coordinates the graph service, the workspace reader and the webview panel.
 */
import * as vscode from 'vscode';

import type { GraphPatch, HostToWebview, MetricSample, RelPath, WebviewToHost } from '../shared';
import { GraphService } from './graphService';
import { openFileAtLine } from './navigation';
import { formatPerformanceReport } from './perf';
import { CodeGraphPanel } from './panel';
import type { CodeGraphSettings } from './settings';
import { SETTINGS_SECTION, readSettings, toViewOptions } from './settings';
import { VsCodeWorkspaceReader } from './workspaceReader';
import { WorkspaceSync } from './workspaceSync';

/** Analysis resources bound to one workspace folder. */
interface AnalysisSession {
  readonly folder: vscode.WorkspaceFolder;
  readonly reader: VsCodeWorkspaceReader;
  readonly service: GraphService;
  /** Live sync of workspace changes; runs while the session exists. */
  readonly sync: WorkspaceSync;
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
 * requests, keeps one analysis session per workspace folder and pushes live
 * graph patches to the panel.
 */
export class CodeGraphController implements vscode.Disposable {
  private panel: CodeGraphPanel | undefined;
  private session: AnalysisSession | undefined;
  private settings: CodeGraphSettings = readSettings(
    vscode.workspace.getConfiguration(SETTINGS_SECTION),
  );
  private readonly configurationListener: vscode.Disposable;

  /**
   * Creates the controller and starts tracking settings changes.
   *
   * @param extensionUri - Root URI of the extension (to locate the webview bundle).
   * @param logger - Extension log channel.
   */
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: vscode.LogOutputChannel,
  ) {
    this.configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SETTINGS_SECTION)) {
        void this.handleSettingsChanged();
      }
    });
  }

  /**
   * Shows the graph panel full size in the editor area, creating it if needed.
   * The analysis starts when the webview reports it is ready.
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
    this.configurationListener.dispose();
    this.panel?.dispose();
    this.panel = undefined;
    this.session?.sync.dispose();
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
      this.session?.sync.dispose();
      const reader = new VsCodeWorkspaceReader(folder.uri);
      const service = new GraphService(reader, this.logger);
      const sync = new WorkspaceSync(
        folder.uri,
        reader,
        service,
        (patch) => {
          void this.postPatch(patch);
        },
        this.logger,
      );
      this.session = { folder, reader, service, sync };
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
        await this.post({ type: 'options', options: toViewOptions(this.settings) });
        await this.sendGraph(false);
        return;
      case 'refresh':
        await this.sendGraph(true);
        return;
      case 'navigate':
        await this.navigate(message.filePath, message.line);
        return;
      case 'metrics':
        this.recordWebviewMetrics(message.samples);
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
      await this.postMeasured('message.init', { type: 'graph/init', graph: current });
      return;
    }

    await this.post({ type: 'status', state: 'analyzing' });
    const startedAt = Date.now();
    try {
      const graph = await session.service.initialize();
      this.logger.info(`Graph sent to webview after ${String(Date.now() - startedAt)} ms.`);
      await this.postMeasured('message.init', { type: 'graph/init', graph });
    } catch (error) {
      const message = describeError(error);
      this.logger.error(`Graph build failed: ${message}`);
      await this.post({ type: 'status', state: 'error', message });
    }
  }

  /**
   * Re-reads the settings and pushes the new view options to the webview.
   */
  private async handleSettingsChanged(): Promise<void> {
    this.settings = readSettings(vscode.workspace.getConfiguration(SETTINGS_SECTION));
    this.logger.info(`Settings updated: ${JSON.stringify(this.settings)}`);
    await this.post({ type: 'options', options: toViewOptions(this.settings) });
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
   * Opens a Markdown report with the performance metrics of the current session.
   */
  public async showPerformanceReport(): Promise<void> {
    if (this.session === undefined) {
      void vscode.window.showInformationMessage(
        'CodeGraph: open the graph first to collect performance metrics.',
      );
      return;
    }
    const content = formatPerformanceReport(
      `CodeGraph performance — ${this.session.folder.name}`,
      this.session.service.performance,
    );
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /**
   * Stores the performance samples measured by the webview.
   *
   * @param samples - Samples received in a `metrics` message.
   */
  private recordWebviewMetrics(samples: readonly MetricSample[]): void {
    const tracker = this.session?.service.performance;
    for (const sample of samples) {
      tracker?.record(`webview.${sample.name}`, sample.value);
    }
  }

  /**
   * Sends a patch to the panel, recording its size and serialization time.
   *
   * @param patch - Patch produced by a live update.
   */
  private async postPatch(patch: GraphPatch): Promise<void> {
    await this.postMeasured('message.patch', { type: 'graph/patch', patch });
  }

  /**
   * Sends a message to the panel, recording its serialized size and the time
   * spent serializing it (VS Code serializes it again internally).
   *
   * @param metricName - Base name of the size and serialization metrics.
   * @param message - Message to deliver.
   */
  private async postMeasured(metricName: string, message: HostToWebview): Promise<void> {
    const tracker = this.session?.service.performance;
    if (tracker !== undefined && this.panel !== undefined) {
      const json = tracker.measure(`${metricName}.serialize`, () => JSON.stringify(message));
      tracker.record(`${metricName}.size`, Buffer.byteLength(json, 'utf8'), 'bytes');
    }
    await this.post(message);
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
