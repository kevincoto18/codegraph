/**
 * Coordinates the graph service, the workspace reader and the webview panel.
 */
import { join } from 'node:path';

import * as vscode from 'vscode';

import type {
  GraphPatch,
  GraphSnapshot,
  HostToWebview,
  MetricSample,
  RelPath,
  ViewPreferences,
  WebviewToHost,
} from '../shared';
import { createGraphInitMessages, readViewPreferences } from '../shared';
import { FileCacheStore, FileGraphStore } from './cacheStore';
import type { EditorLocation } from './editorSync';
import { EditorSyncScheduler } from './editorSync';
import { resolveFocusTarget } from './focusTarget';
import type { GraphService, ScanProgressListener } from './graphService';
import { openFileAtLine } from './navigation';
import { formatPerformanceReport } from './perf';
import type { PanelPlacement } from './panel';
import { CodeGraphPanel } from './panel';
import type { CodeGraphSettings } from './settings';
import { SETTINGS_SECTION, readSettings, toViewOptions } from './settings';
import { MultiRootWorkspaceReader } from './multiRootReader';
import { WorkspaceSync } from './workspaceSync';

/** Analysis resources bound to the folders of the workspace. */
interface AnalysisSession {
  /** Analyzed workspace folders. */
  readonly folders: readonly vscode.WorkspaceFolder[];
  readonly reader: MultiRootWorkspaceReader;
  readonly service: GraphService;
  /** Live sync of workspace changes; runs while the session exists. */
  readonly sync: WorkspaceSync;
}

/** Where and under which version the parse cache is persisted. */
export interface CacheLocation {
  /** Workspace-specific storage folder (`ExtensionContext.storageUri`), if any. */
  readonly storageUri: vscode.Uri | undefined;
  /** Extension version; a new version discards the persisted cache. */
  readonly extensionVersion: string;
}

/** File name of the persisted parse cache inside the storage folder. */
const CACHE_FILE_NAME = 'parse-cache.bin';

/** File name of the last graph inside the storage folder. */
const GRAPH_FILE_NAME = 'graph.bin';

/** Key of the view preferences in the workspace state. */
const PREFERENCES_KEY = 'codegraph.viewPreferences';

/** Number of progress steps reported during a scan (one every 2%). */
const PROGRESS_STEPS = 50;

/**
 * Identity of a set of workspace folders (order matters: it sets the path prefixes).
 *
 * @param folders - Workspace folders.
 * @returns A short stable key.
 */
function sessionKeyOf(folders: readonly vscode.WorkspaceFolder[]): string {
  const text = folders.map((folder) => `${folder.name}\u0000${folder.uri.toString()}`).join('\n');
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return `roots${String(folders.length)}-${hash.toString(36)}`;
}

/**
 * Human-readable list of folder names, for logs and titles.
 *
 * @param folders - Workspace folders.
 * @returns E.g. `"api", "web"`.
 */
function folderNames(folders: readonly vscode.WorkspaceFolder[]): string {
  return folders.map((folder) => `"${folder.name}"`).join(', ');
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
  /** Session being created or ready, keyed by folder URI. */
  private sessionRequest:
    { readonly key: string; readonly session: Promise<AnalysisSession> } | undefined;
  /** Resolved session, for synchronous access. */
  private session: AnalysisSession | undefined;
  /** Pending session releases (cache persistence). */
  private closing: Promise<void> = Promise.resolve();
  /** Whether the panel shows an up-to-date graph (focus requests can be sent). */
  private graphShown = false;
  /** Location to focus once the graph is shown ("Show Connections"). */
  private pendingFocus: { readonly uri: vscode.Uri; readonly line?: number } | undefined;
  private settings: CodeGraphSettings = readSettings(
    vscode.workspace.getConfiguration(SETTINGS_SECTION),
  );
  private readonly configurationListener: vscode.Disposable;
  /** View preferences of the workspace (filters, editor sync). */
  private preferences: ViewPreferences;
  /** Listeners of the active editor, its cursor (editor sync) and the workspace folders. */
  private readonly editorListeners: vscode.Disposable[];
  /** Debounces cursor moves before they are mirrored in the graph. */
  private readonly editorSync = new EditorSyncScheduler<vscode.Uri>((location) => {
    void this.revealInGraph(location);
  });
  /** Last node revealed by the editor sync, to skip repeated messages. */
  private lastRevealedId: string | undefined;

  /**
   * Creates the controller and starts tracking settings changes.
   *
   * @param extensionUri - Root URI of the extension (to locate the webview bundle).
   * @param logger - Extension log channel.
   * @param cacheLocation - Where the parse cache is persisted.
   * @param workspaceState - Per-workspace storage of the view preferences.
   */
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: vscode.LogOutputChannel,
    private readonly cacheLocation: CacheLocation,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.preferences = readViewPreferences(workspaceState.get(PREFERENCES_KEY));
    this.configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SETTINGS_SECTION)) {
        void this.handleSettingsChanged();
      }
    });
    this.editorListeners = [
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.followEditor(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.followEditor(event.textEditor);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.handleFoldersChanged();
      }),
    ];
  }

  /**
   * Starts a new analysis when workspace folders are added or removed, and
   * shows its graph if the panel is open.
   */
  private async handleFoldersChanged(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.logger.info(`Workspace folders changed: ${folderNames(folders)}.`);
    if (this.panel === undefined || folders.length === 0) {
      await this.closeSession();
      return;
    }
    this.graphShown = false;
    void this.ensureSession(folders);
    await this.sendGraph(false);
  }

  /**
   * Schedules mirroring the cursor of an editor in the graph, when editor
   * sync is on and the graph is open.
   *
   * @param editor - Editor whose cursor moved or that became active.
   */
  private followEditor(editor: vscode.TextEditor | undefined): void {
    if (!this.preferences.editorSync || this.panel === undefined || editor === undefined) {
      return;
    }
    this.editorSync.schedule({
      uri: editor.document.uri,
      line: editor.selection.active.line + 1,
    });
  }

  /**
   * Starts following the active editor from scratch (graph shown again or
   * sync just turned on).
   */
  private resyncEditor(): void {
    this.lastRevealedId = undefined;
    this.followEditor(vscode.window.activeTextEditor);
  }

  /**
   * Highlights the file or function under the cursor in the graph.
   *
   * @param location - Cursor location in the editor.
   */
  private async revealInGraph(location: EditorLocation<vscode.Uri>): Promise<void> {
    if (!this.preferences.editorSync || !this.graphShown || this.panel === undefined) {
      return;
    }
    const session = this.session;
    if (session?.service.hasScanned !== true) {
      return;
    }
    const filePath = session.reader.toRelPath(location.uri);
    const nodeId =
      filePath === null
        ? null
        : resolveFocusTarget(session.service.getSnapshot(), filePath, location.line);
    if (nodeId === null || nodeId === this.lastRevealedId) {
      return;
    }
    this.lastRevealedId = nodeId;
    await this.post({ type: 'reveal', nodeId });
  }

  /**
   * Stores the preferences chosen in the webview.
   *
   * @param preferences - New preferences.
   */
  private async savePreferences(preferences: ViewPreferences): Promise<void> {
    const syncTurnedOn = preferences.editorSync && !this.preferences.editorSync;
    this.preferences = preferences;
    if (!preferences.editorSync) {
      this.editorSync.cancel();
    }
    await this.workspaceState.update(PREFERENCES_KEY, preferences);
    if (syncTurnedOn) {
      this.resyncEditor();
    }
  }

  /**
   * Shows the graph panel, creating it if needed. The analysis starts when the
   * webview reports it is ready.
   *
   * @param placement - Where to show it; by default the whole active editor
   *   area (a panel that already exists stays where it is).
   */
  public openGraph(placement?: PanelPlacement): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage('CodeGraph: open a folder to analyze.');
      return;
    }
    void this.ensureSession(folders);

    if (this.panel !== undefined) {
      this.panel.reveal(placement);
      return;
    }
    this.panel = CodeGraphPanel.create(
      this.extensionUri,
      (message) => {
        void this.handleMessage(message);
      },
      () => {
        this.panel = undefined;
        this.graphShown = false;
      },
      this.logger,
      placement,
    );
  }

  /**
   * Takes over a CodeGraph panel restored by VS Code after a window reload:
   * the webview reloads, asks for the graph and restores the view it saved.
   *
   * @param panel - Restored panel.
   */
  public restorePanel(panel: vscode.WebviewPanel): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0 || this.panel !== undefined) {
      panel.dispose();
      return;
    }
    void this.ensureSession(folders);
    this.panel = CodeGraphPanel.restore(
      panel,
      this.extensionUri,
      (message) => {
        void this.handleMessage(message);
      },
      () => {
        this.panel = undefined;
        this.graphShown = false;
      },
      this.logger,
    );
    this.logger.info('Graph panel restored after a reload.');
  }

  /**
   * Opens the graph focused on a file, or on the function under the cursor
   * when invoked from the editor ("CodeGraph: Show Connections").
   *
   * @param uri - File chosen in the Explorer or editor; defaults to the active editor.
   */
  public async showConnections(uri?: vscode.Uri): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const target = uri ?? editor?.document.uri;
    if (target === undefined) {
      void vscode.window.showInformationMessage('CodeGraph: open or select a source file first.');
      return;
    }
    const line =
      editor?.document.uri.toString() === target.toString()
        ? editor.selection.active.line + 1
        : undefined;
    this.pendingFocus = line === undefined ? { uri: target } : { uri: target, line };
    this.openGraph(this.besideEditor(editor));
    await this.flushFocus();
  }

  /**
   * Chooses where to show the graph next to an editor: in a split beside it,
   * keeping the focus in the editor, so the code stays visible. A graph
   * already shown in another column stays there.
   *
   * @param editor - Active editor, if any.
   * @returns The placement, or `undefined` (default placement) without an editor.
   */
  private besideEditor(editor: vscode.TextEditor | undefined): PanelPlacement | undefined {
    if (editor === undefined) {
      return undefined;
    }
    const panelColumn = this.panel?.viewColumn;
    const viewColumn =
      panelColumn !== undefined && panelColumn !== editor.viewColumn
        ? panelColumn
        : vscode.ViewColumn.Beside;
    return { viewColumn, preserveFocus: true };
  }

  /**
   * Sends the pending focus once the panel shows an up-to-date graph.
   */
  private async flushFocus(): Promise<void> {
    const request = this.pendingFocus;
    if (request === undefined || !this.graphShown || this.panel === undefined) {
      return;
    }
    const session = await this.currentSession();
    if (session?.service.hasScanned !== true) {
      return;
    }
    this.pendingFocus = undefined;
    const filePath = session.reader.toRelPath(request.uri);
    const nodeId =
      filePath === null
        ? null
        : resolveFocusTarget(session.service.getSnapshot(), filePath, request.line);
    if (nodeId === null) {
      void vscode.window.showInformationMessage(
        'CodeGraph: this file is not part of the graph (unsupported or excluded).',
      );
      return;
    }
    await this.post({ type: 'focus', nodeId });
  }

  /**
   * Graph of the current analysis.
   *
   * @returns The latest graph, or `null` before the first scan.
   */
  public getGraph(): GraphSnapshot | null {
    const service = this.session?.service;
    return service?.hasScanned === true ? service.getSnapshot() : null;
  }

  /** Closes the panel and releases resources. */
  public dispose(): void {
    this.configurationListener.dispose();
    this.editorListeners.forEach((listener) => {
      listener.dispose();
    });
    this.editorSync.cancel();
    this.panel?.dispose();
    this.panel = undefined;
    void this.closeSession();
  }

  /**
   * Releases the session and waits until the parse cache is persisted.
   * Concurrent calls (dispose, deactivate) share the same pending release.
   *
   * @returns Resolves once every pending release has finished.
   */
  public closeSession(): Promise<void> {
    const request = this.sessionRequest;
    this.sessionRequest = undefined;
    this.session = undefined;
    if (request !== undefined) {
      this.closing = this.closing.then(() => this.releaseSession(request.session));
    }
    return this.closing;
  }

  /**
   * Stops a session's workspace sync and persists its cache.
   *
   * @param pending - Session to release (possibly still starting).
   */
  private async releaseSession(pending: Promise<AnalysisSession>): Promise<void> {
    try {
      const session = await pending;
      session.sync.dispose();
      await session.service.dispose();
    } catch {
      // The session failed to start: nothing to release.
    }
  }

  /**
   * Returns the session of the workspace folders, creating a new one if the
   * folders changed.
   *
   * @param folders - Workspace folders to analyze.
   * @returns The active session.
   */
  private ensureSession(folders: readonly vscode.WorkspaceFolder[]): Promise<AnalysisSession> {
    const key = sessionKeyOf(folders);
    const existing = this.sessionRequest;
    if (existing?.key === key) {
      return existing.session;
    }
    void this.closeSession();
    const session = this.createSession(folders, key);
    this.sessionRequest = { key, session };
    session.then(
      (created) => {
        if (this.sessionRequest?.session === session) {
          this.session = created;
        }
      },
      (error: unknown) => {
        this.logger.error(`Could not start the analysis: ${describeError(error)}`);
      },
    );
    return session;
  }

  /**
   * Creates the analysis resources of the workspace folders. The analyzer
   * (and the TypeScript compiler it bundles) is loaded on first use, so
   * activating the extension stays instantaneous.
   *
   * @param folders - Workspace folders to analyze.
   * @param sessionKey - Identity of the folder set (part of the cache key).
   * @returns The new session.
   */
  private async createSession(
    folders: readonly vscode.WorkspaceFolder[],
    sessionKey: string,
  ): Promise<AnalysisSession> {
    const startedAt = Date.now();
    const {
      GraphService: Service,
      ANALYSIS_CACHE_KEY,
      createDefaultParsePool,
    } = await import('./analysis');
    const reader = new MultiRootWorkspaceReader(folders, (message) => {
      this.logger.warn(message);
    });
    const storageUri = this.cacheLocation.storageUri;
    // Caches of another folder set (paths are prefixed differently) are discarded.
    const key = `${ANALYSIS_CACHE_KEY}-ext${this.cacheLocation.extensionVersion}-${sessionKey}`;
    const stores =
      storageUri === undefined
        ? {}
        : {
            store: new FileCacheStore(join(storageUri.fsPath, CACHE_FILE_NAME), key, this.logger),
            graphStore: new FileGraphStore(
              join(storageUri.fsPath, GRAPH_FILE_NAME),
              key,
              this.logger,
            ),
          };
    const service = new Service(reader, this.logger, undefined, {
      ...stores,
      createParsePool: createDefaultParsePool,
    });
    const sync = new WorkspaceSync(
      reader.rootUris,
      reader,
      service,
      (patch) => {
        void this.postPatch(patch);
      },
      this.logger,
    );
    this.logger.info(
      `Analysis session created for ${folderNames(folders)} (analyzer loaded in ${String(Date.now() - startedAt)} ms).`,
    );
    return { folders, reader, service, sync };
  }

  /**
   * Waits for the current session.
   *
   * @returns The session, or `undefined` if none was requested or it failed.
   */
  private async currentSession(): Promise<AnalysisSession | undefined> {
    try {
      return await this.sessionRequest?.session;
    } catch {
      return undefined;
    }
  }

  /**
   * Dispatches a validated webview message.
   *
   * @param message - Message received from the webview.
   */
  private async handleMessage(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.post({ type: 'preferences', preferences: this.preferences });
        await this.post({
          type: 'options',
          options: toViewOptions(this.settings, vscode.workspace.workspaceFolders?.length ?? 1),
        });
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
      case 'preferences':
        await this.savePreferences(message.preferences);
        return;
    }
  }

  /**
   * Sends the full graph to the webview, scanning the workspace if needed.
   *
   * @param forceRescan - Rescan even if a graph is already available.
   */
  private async sendGraph(forceRescan: boolean): Promise<void> {
    const session = await this.currentSession();
    if (session === undefined) {
      return;
    }
    const service = session.service;
    if (!forceRescan && service.hasScanned) {
      await this.postGraph(service.getSnapshot());
      this.graphShown = true;
      await this.flushFocus();
      this.resyncEditor();
      return;
    }

    // Show the graph of the previous session right away, then rescan.
    const saved = forceRescan ? null : await service.loadSavedGraph();
    if (saved !== null) {
      this.logger.info(`Showing the graph saved by the previous session while rescanning.`);
      await this.postGraph(saved);
    }
    await this.post({ type: 'status', state: 'analyzing' });
    const startedAt = Date.now();
    try {
      if (saved === null) {
        const graph = await this.withScanProgress((onProgress) => service.initialize(onProgress));
        await this.postGraph(graph);
      } else {
        const { snapshot, patch } = await this.withScanProgress((onProgress) =>
          service.revalidate(saved, onProgress),
        );
        if (patch === null) {
          await this.postGraph(snapshot);
        } else {
          await this.postPatch(patch);
          await this.post({ type: 'status', state: 'ready' });
        }
      }
      this.logger.info(
        `Graph up to date in the webview after ${String(Date.now() - startedAt)} ms.`,
      );
      this.graphShown = true;
      await this.flushFocus();
      this.resyncEditor();
    } catch (error) {
      const message = describeError(error);
      this.logger.error(`Graph build failed: ${message}`);
      await this.post({ type: 'status', state: 'error', message });
    }
  }

  /**
   * Runs a scan showing its progress in the VS Code status bar.
   *
   * @param scan - Scan to run; receives the progress listener.
   * @returns The scan's result.
   */
  private withScanProgress<T>(scan: (onProgress: ScanProgressListener) => Promise<T>): Promise<T> {
    return Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'CodeGraph' },
        (progress) => {
          let lastStep = -1;
          return scan((done, total) => {
            const step = total === 0 ? PROGRESS_STEPS : Math.floor((done * PROGRESS_STEPS) / total);
            if (step !== lastStep) {
              lastStep = step;
              progress.report({ message: `Analyzing ${String(done)}/${String(total)} files` });
            }
          });
        },
      ),
    );
  }

  /**
   * Sends a full graph as a sequence of compact `graph/init` parts, recording
   * their total size and serialization time.
   *
   * @param snapshot - Graph to send.
   */
  private async postGraph(snapshot: GraphSnapshot): Promise<void> {
    const tracker = this.session?.service.performance;
    const messages =
      tracker === undefined
        ? createGraphInitMessages(snapshot)
        : tracker.measure('message.init.encode', () => createGraphInitMessages(snapshot));
    if (tracker !== undefined && this.panel !== undefined) {
      const startedAt = performance.now();
      const bytes = messages.reduce(
        (total, message) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'),
        0,
      );
      tracker.record('message.init.serialize', performance.now() - startedAt);
      tracker.record('message.init.size', bytes, 'bytes');
      tracker.record('message.init.parts', messages.length, 'count');
    }
    for (const message of messages) {
      await this.post(message);
    }
  }

  /**
   * Re-reads the settings and pushes the new view options to the webview.
   */
  private async handleSettingsChanged(): Promise<void> {
    this.settings = readSettings(vscode.workspace.getConfiguration(SETTINGS_SECTION));
    this.logger.info(`Settings updated: ${JSON.stringify(this.settings)}`);
    await this.post({
      type: 'options',
      options: toViewOptions(this.settings, vscode.workspace.workspaceFolders?.length ?? 1),
    });
  }

  /**
   * Opens a workspace file at a line, in a column different from the panel's.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param line - 1-based line.
   */
  private async navigate(filePath: RelPath, line: number): Promise<void> {
    const session = await this.currentSession();
    if (session === undefined) {
      return;
    }
    const viewColumn =
      this.panel?.viewColumn === vscode.ViewColumn.One
        ? vscode.ViewColumn.Beside
        : vscode.ViewColumn.One;
    try {
      await openFileAtLine(session.reader.toUri(filePath), line, viewColumn);
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
      `CodeGraph performance — ${folderNames(this.session.folders)}`,
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
