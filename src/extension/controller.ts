/**
 * Coordinates the graph service, the workspace reader and the webview panel.
 */
import { join } from 'node:path';

import * as vscode from 'vscode';

import type {
  FunctionDetails,
  GraphPatch,
  GraphSnapshot,
  HostToWebview,
  MetricSample,
  RelPath,
  ReviewMode,
  ReviewState,
  ViewPreferences,
  WebviewToHost,
} from '../shared';
import {
  changedNodeIds,
  createFileId,
  createGraphInitMessages,
  readViewPreferences,
} from '../shared';
import { FileCacheStore, FileGraphStore } from './cacheStore';
import type { EditorLocation } from './editorSync';
import { EditorSyncScheduler } from './editorSync';
import { resolveFocusTarget } from './focusTarget';
import type { GraphService, ScanProgressListener } from './graphService';
import { openFileAtLine } from './navigation';
import { decodeDataUrl, exportFilters } from './exportFiles';
import { extractFunctionDetails } from './functionDetails';
import type { MiniGraphSource } from './miniGraphView';
import { formatPerformanceReport } from './perf';
import type { PanelPlacement } from './panel';
import { CodeGraphPanel } from './panel';
import type { CodeGraphSettings } from './settings';
import { SETTINGS_SECTION, readSettings, toViewOptions } from './settings';
import { MultiRootWorkspaceReader } from './multiRootReader';
import { mapChanges } from './review/changeMapper';
import { getGitApi } from './review/gitAccess';
import { ReviewError, collectChanges, listBranches } from './review/gitChanges';
import { assignRootPrefixes } from './rootPaths';
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

/** Quiet period after a file change before the review is recomputed, in milliseconds. */
const REVIEW_REFRESH_DELAY_MS = 1000;

/** Setting with the branch reviews compare with (empty: main, master or develop). */
const REVIEW_BASE_SETTING = 'review.baseBranch';

/** Key of the base branch picked in the Changes tab, in the workspace state. */
const REVIEW_BRANCH_KEY = 'codegraph.reviewBranch';

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
 * Top-level folder names of the open workspace folders, as they prefix the
 * paths of the graph (see `rootPaths.ts`).
 *
 * @returns One name per folder, or an empty list with a single folder.
 */
function workspaceRootNames(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length > 1 ? assignRootPrefixes(folders.map((folder) => folder.name)) : [];
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
export class CodeGraphController implements vscode.Disposable, MiniGraphSource {
  private panel: CodeGraphPanel | undefined;
  /** Scan running for the current session, shared by the panel and the side view. */
  private scanInFlight: Promise<void> | undefined;
  private readonly graphChanged = new vscode.EventEmitter<void>();
  /** Fires when the graph changes (scan finished, live patch, folders changed). */
  public readonly onDidChangeGraph = this.graphChanged.event;
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
  private pendingFocus:
    { readonly uri: vscode.Uri; readonly line?: number } | { readonly nodeId: string } | undefined;
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
  /** Change review shown in the panel, or `null` when none is running. */
  private review: { readonly mode: ReviewMode; readonly state: ReviewState } | null = null;
  /** Whether the panel must open its Changes tab ("Review Changes" before it was ready). */
  private reviewOpenPending = false;
  /** Increases with every review run; older runs are dropped. */
  private reviewToken = 0;
  /** Pending review refresh after file changes. */
  private reviewRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Base branch picked in the Changes tab; empty to use the setting or detect it. */
  private reviewBranch = '';
  /** Branches offered as base, read with the last review. */
  private reviewBranches: readonly string[] = [];

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
    const pickedBranch: unknown = workspaceState.get(REVIEW_BRANCH_KEY);
    this.reviewBranch = typeof pickedBranch === 'string' ? pickedBranch : '';
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
      this.graphChanged.fire();
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
        this.stopReview();
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
        this.stopReview();
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
    const snapshot = session.service.getSnapshot();
    let nodeId: string | null;
    if ('nodeId' in request) {
      nodeId = snapshot.nodes.some((node) => node.id === request.nodeId) ? request.nodeId : null;
    } else {
      const filePath = session.reader.toRelPath(request.uri);
      nodeId = filePath === null ? null : resolveFocusTarget(snapshot, filePath, request.line);
    }
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

  /**
   * Whether a workspace folder is open.
   *
   * @returns `true` with at least one folder.
   */
  public hasFolders(): boolean {
    return (vscode.workspace.workspaceFolders ?? []).length > 0;
  }

  /**
   * Returns the graph, scanning the workspace first if needed. A scan already
   * running (for the panel) is shared, never repeated.
   *
   * @returns The graph, or `null` without folders or when the scan failed.
   */
  public async ensureGraph(): Promise<GraphSnapshot | null> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return null;
    }
    let session: AnalysisSession;
    try {
      session = await this.ensureSession(folders);
    } catch {
      return null;
    }
    if (!session.service.hasScanned) {
      await this.scanOnce(session, false, false);
    }
    return session.service.hasScanned ? session.service.getSnapshot() : null;
  }

  /**
   * Workspace-relative path of a document in the analyzed folders.
   *
   * @param uri - Document URI.
   * @returns The path, or `null` outside the folders or before the session starts.
   */
  public toRelPath(uri: vscode.Uri): RelPath | null {
    return this.session?.reader.toRelPath(uri) ?? null;
  }

  /**
   * Opens a workspace file at a line in the active editor column (used by the
   * side view, which lives outside the editor area).
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param line - 1-based line.
   */
  public async openInEditor(filePath: RelPath, line: number): Promise<void> {
    const session = await this.currentSession();
    if (session === undefined) {
      return;
    }
    const panelColumn = this.panel?.viewColumn;
    const activeColumn = vscode.window.activeTextEditor?.viewColumn;
    const viewColumn =
      activeColumn !== undefined && activeColumn !== panelColumn
        ? activeColumn
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
   * Opens the full graph beside the editor, focused on a node.
   *
   * @param nodeId - File or function to focus.
   */
  public async showInGraph(nodeId: string): Promise<void> {
    this.pendingFocus = { nodeId };
    this.openGraph(this.besideEditor(vscode.window.activeTextEditor));
    await this.flushFocus();
  }

  /**
   * Opens the graph on the Changes tab and reviews the changes ("CodeGraph:
   * Review Changes"), against the base branch unless a review is running.
   */
  public async reviewChanges(): Promise<void> {
    this.openGraph(this.besideEditor(vscode.window.activeTextEditor));
    if (this.panel === undefined) {
      return;
    }
    await this.runReview(this.review?.mode ?? 'base', true);
  }

  /**
   * Graph ids of the files and functions touched by the running review.
   *
   * @returns The ids (empty without a review).
   */
  public getChangedIds(): ReadonlySet<string> {
    const state = this.review?.state;
    return state?.status === 'ready' ? changedNodeIds(state.result, createFileId) : new Set();
  }

  /**
   * Computes the changes of a review mode and sends them to the panel.
   *
   * @param mode - What to compare with.
   * @param open - Ask the panel to show its Changes tab.
   */
  private async runReview(mode: ReviewMode, open: boolean): Promise<void> {
    const token = ++this.reviewToken;
    if (this.reviewRefreshTimer !== undefined) {
      clearTimeout(this.reviewRefreshTimer);
      this.reviewRefreshTimer = undefined;
    }
    // A refresh keeps showing the previous result until the new one is ready.
    if (this.review?.mode !== mode || this.review.state.status !== 'ready') {
      this.review = { mode, state: { status: 'loading', mode } };
    }
    this.reviewOpenPending ||= open;
    await this.postReview();
    let state: ReviewState;
    try {
      state = await this.computeReview(mode);
    } catch (error) {
      state =
        error instanceof ReviewError
          ? { status: 'unavailable', mode, problem: error.problem, message: error.message }
          : { status: 'unavailable', mode, problem: 'error', message: describeError(error) };
      this.logger.warn(`Review (${mode}) not available: ${state.message}`);
    }
    // A newer run, or stopping the review, supersedes this one.
    if (token !== this.reviewToken) {
      return;
    }
    this.review = { mode, state };
    await this.postReview();
    this.graphChanged.fire();
  }

  /**
   * Reads the changes from git and maps them to the graph.
   *
   * @param mode - What to compare with.
   * @returns The ready state.
   * @throws {ReviewError} Without git, repository or base.
   */
  private async computeReview(mode: ReviewMode): Promise<ReviewState> {
    const snapshot = await this.ensureGraph();
    const session = this.session;
    if (snapshot === null || session === undefined) {
      throw new ReviewError('error', 'The graph is not available.');
    }
    const git = await getGitApi();
    if (git === null) {
      throw new ReviewError('no-git', 'The Git extension of VS Code is disabled or missing.');
    }
    const startedAt = Date.now();
    const baseBranch =
      this.reviewBranch !== ''
        ? this.reviewBranch
        : vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string>(REVIEW_BASE_SETTING, '');
    const reader = session.reader;
    try {
      this.reviewBranches = await listBranches(git, reader.rootUris);
    } catch (error) {
      this.logger.warn(`Could not list the branches: ${describeError(error)}`);
    }
    const collected = await collectChanges(
      git,
      {
        roots: reader.rootUris,
        toRelPath: (uri) => reader.toRelPath(vscode.Uri.parse(uri.toString())),
        readFile: (filePath) => reader.readFile(filePath),
      },
      mode,
      baseBranch,
    );
    const files = mapChanges(session.service.getSnapshot(), collected.changes);
    this.logger.info(
      `Review (${mode}, ${collected.base}): ${String(files.length)} changed files in ${String(Date.now() - startedAt)} ms.`,
    );
    return {
      status: 'ready',
      result: { mode, base: collected.base, files, truncated: collected.truncated },
    };
  }

  /** Stops the running review and clears it from the panel and the side view. */
  private stopReview(): void {
    this.reviewToken += 1;
    this.review = null;
    this.reviewOpenPending = false;
    if (this.reviewRefreshTimer !== undefined) {
      clearTimeout(this.reviewRefreshTimer);
      this.reviewRefreshTimer = undefined;
    }
    void this.post({
      type: 'review',
      state: null,
      open: false,
      branches: this.reviewBranches,
      branch: this.reviewBranch,
    });
    this.graphChanged.fire();
  }

  /** Recomputes the running review shortly after files change (line numbers move). */
  private scheduleReviewRefresh(): void {
    const review = this.review;
    if (review === null) {
      return;
    }
    if (this.reviewRefreshTimer !== undefined) {
      clearTimeout(this.reviewRefreshTimer);
    }
    this.reviewRefreshTimer = setTimeout(() => {
      this.reviewRefreshTimer = undefined;
      void this.runReview(review.mode, false);
    }, REVIEW_REFRESH_DELAY_MS);
  }

  /**
   * Sends the review state to the panel (and the pending request to open its tab).
   */
  private async postReview(): Promise<void> {
    // Before the panel shows its graph, the `ready` handshake sends it.
    if (this.panel === undefined || !this.graphShown || this.review === null) {
      return;
    }
    const open = this.reviewOpenPending;
    this.reviewOpenPending = false;
    await this.post({
      type: 'review',
      state: this.review.state,
      open,
      branches: this.reviewBranches,
      branch: this.reviewBranch,
    });
  }

  /** Closes the panel and releases resources. */
  public dispose(): void {
    if (this.reviewRefreshTimer !== undefined) {
      clearTimeout(this.reviewRefreshTimer);
    }
    this.graphChanged.dispose();
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
    this.scanInFlight = undefined;
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
        this.graphChanged.fire();
        this.scheduleReviewRefresh();
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
          options: toViewOptions(this.settings, workspaceRootNames()),
        });
        await this.sendGraph(false);
        await this.postReview();
        return;
      case 'review':
        if (message.branch !== undefined && message.branch !== this.reviewBranch) {
          this.reviewBranch = message.branch;
          await this.workspaceState.update(REVIEW_BRANCH_KEY, message.branch);
        }
        if (message.mode === null) {
          this.stopReview();
        } else {
          await this.runReview(message.mode, false);
        }
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
      case 'export':
        await this.saveExport(message.fileName, message.format, message.data);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.showInformationMessage('CodeGraph: copied to the clipboard.');
        return;
      case 'details':
        await this.post({
          type: 'details',
          requestId: message.requestId,
          nodeId: message.nodeId,
          details: await this.readFunctionDetails(message.nodeId),
        });
        return;
    }
  }

  /**
   * Asks where to save an export and writes it.
   *
   * @param fileName - Suggested file name.
   * @param format - Export format.
   * @param data - Mermaid text, or the image as a `data:` URL.
   */
  private async saveExport(
    fileName: string,
    format: 'png' | 'svg' | 'mermaid',
    data: string,
  ): Promise<void> {
    const bytes = format === 'mermaid' ? new TextEncoder().encode(data) : decodeDataUrl(data);
    if (bytes === null) {
      this.logger.warn(`Ignored an invalid ${format} export from the webview.`);
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      ...(folder === undefined ? {} : { defaultUri: vscode.Uri.joinPath(folder, fileName) }),
      filters: exportFilters(format),
      saveLabel: 'Export',
      title: 'Export the CodeGraph diagram',
    });
    if (target === undefined) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, bytes);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `CodeGraph: could not save the export: ${describeError(error)}`,
      );
      return;
    }
    this.logger.info(`Exported ${format} to ${target.toString(true)}.`);
    const choice = await vscode.window.showInformationMessage(
      `CodeGraph: exported to ${target.path.slice(target.path.lastIndexOf('/') + 1)}.`,
      'Open',
    );
    if (choice === 'Open') {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  /**
   * Reads the signature and documentation of a function from its file, for
   * the hover card.
   *
   * @param nodeId - Function node id.
   * @returns The details, or `null` when the function or its file is gone.
   */
  public async readFunctionDetails(nodeId: string): Promise<FunctionDetails | null> {
    const session = this.session;
    if (session?.service.hasScanned !== true) {
      return null;
    }
    const node = session.service.getSnapshot().nodes.find((item) => item.id === nodeId);
    if (node?.kind !== 'function') {
      return null;
    }
    try {
      const text = await session.reader.readFile(node.filePath);
      return extractFunctionDetails(text, node.filePath, node.line);
    } catch (error) {
      this.logger.warn(`Could not read details of ${nodeId}: ${describeError(error)}`);
      return null;
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
    if (!forceRescan && this.scanInFlight !== undefined) {
      // A scan started by the side view: wait for it, then show its graph.
      await this.post({ type: 'status', state: 'analyzing' });
      await this.scanInFlight;
    }
    if (!forceRescan && service.hasScanned) {
      await this.postGraph(service.getSnapshot());
      this.graphShown = true;
      await this.flushFocus();
      this.resyncEditor();
      return;
    }
    await this.scanOnce(session, forceRescan, true);
  }

  /**
   * Starts a scan of the session, or joins the one already running.
   *
   * @param session - Session to scan.
   * @param forceRescan - Ignore the graph saved by the previous session.
   * @param showInPanel - Stream the scan's graph to the panel.
   * @returns Resolves once the scan has finished (errors are reported, not thrown).
   */
  private scanOnce(
    session: AnalysisSession,
    forceRescan: boolean,
    showInPanel: boolean,
  ): Promise<void> {
    if (this.scanInFlight !== undefined && !forceRescan) {
      return this.scanInFlight;
    }
    const run = this.scan(session, forceRescan, showInPanel).finally(() => {
      if (this.scanInFlight === run) {
        this.scanInFlight = undefined;
      }
      this.graphChanged.fire();
    });
    this.scanInFlight = run;
    return run;
  }

  /**
   * Scans the workspace: shows the graph of the previous session right away
   * (when there is one), then revalidates it, or builds it from scratch.
   *
   * @param session - Session to scan.
   * @param forceRescan - Ignore the graph saved by the previous session.
   * @param showInPanel - Stream the scan's graph to the panel.
   */
  private async scan(
    session: AnalysisSession,
    forceRescan: boolean,
    showInPanel: boolean,
  ): Promise<void> {
    const service = session.service;
    /**
     * Posts to the panel only when this scan streams to it.
     *
     * @param message - Message to deliver.
     */
    const post = async (message: HostToWebview): Promise<void> => {
      if (showInPanel) {
        await this.post(message);
      }
    };
    const saved = forceRescan ? null : await service.loadSavedGraph();
    if (saved !== null && showInPanel) {
      this.logger.info(`Showing the graph saved by the previous session while rescanning.`);
      await this.postGraph(saved);
    }
    await post({ type: 'status', state: 'analyzing' });
    const startedAt = Date.now();
    try {
      if (saved === null) {
        const graph = await this.withScanProgress((onProgress) => service.initialize(onProgress));
        if (showInPanel) {
          await this.postGraph(graph);
        }
      } else {
        const { snapshot, patch } = await this.withScanProgress((onProgress) =>
          service.revalidate(saved, onProgress),
        );
        if (!showInPanel) {
          // Nothing to stream.
        } else if (patch === null) {
          await this.postGraph(snapshot);
        } else {
          await this.postPatch(patch);
          await this.post({ type: 'status', state: 'ready' });
        }
      }
      this.logger.info(`Graph up to date after ${String(Date.now() - startedAt)} ms.`);
      if (showInPanel) {
        this.graphShown = true;
        await this.flushFocus();
        this.resyncEditor();
      }
    } catch (error) {
      const message = describeError(error);
      this.logger.error(`Graph build failed: ${message}`);
      await post({ type: 'status', state: 'error', message });
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
      options: toViewOptions(this.settings, workspaceRootNames()),
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
