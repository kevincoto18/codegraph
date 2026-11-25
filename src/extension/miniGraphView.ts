/**
 * "CodeGraph" side view in the Explorer: a small graph of what the active
 * file (or the function under the cursor) uses and what uses it.
 */
import * as vscode from 'vscode';

import type {
  FunctionDetails,
  GraphSnapshot,
  MiniEmptyReason,
  MiniHostToView,
  MiniMode,
  RelPath,
} from '../shared';
import { isMiniViewToHostMessage } from '../shared';
import { EditorSyncScheduler } from './editorSync';
import { resolveFocusTarget } from './focusTarget';
import { computeMiniGraph } from './miniGraph';
import { buildWebviewHtml, createNonce } from './webviewHtml';

/** View id contributed in `package.json` (`contributes.views.explorer`). */
export const MINI_VIEW_ID = 'codegraph.miniGraph';

/** Key of the chosen mode in the workspace state. */
const MODE_KEY = 'codegraph.miniMode';

/** Quiet period before the view follows the cursor, in milliseconds. */
const FOLLOW_DELAY_MS = 150;

/** Folder of the webview bundle, relative to the extension root. */
const WEBVIEW_DIST_SEGMENTS = ['dist', 'webview'] as const;

/** What the side view needs from the rest of the extension. */
export interface MiniGraphSource {
  /** Fires when the graph changes (scan finished, live patch, folders changed). */
  readonly onDidChangeGraph: vscode.Event<void>;
  /** Whether a workspace folder is open. */
  hasFolders(): boolean;
  /** Graph if already built, without scanning. */
  getGraph(): GraphSnapshot | null;
  /** Builds the graph if needed (shares a scan already running). */
  ensureGraph(): Promise<GraphSnapshot | null>;
  /** Workspace-relative path of a document, or `null` outside the analyzed folders. */
  toRelPath(uri: vscode.Uri): RelPath | null;
  /** Signature and docs of a function. */
  readFunctionDetails(nodeId: string): Promise<FunctionDetails | null>;
  /** Opens a file at a line in the editor. */
  openInEditor(filePath: RelPath, line: number): Promise<void>;
  /** Opens the full graph focused on a node. */
  showInGraph(nodeId: string): Promise<void>;
  /** Nodes changed in the running change review (empty without one). */
  getChangedIds(): ReadonlySet<string>;
}

/** Editor location the view follows. */
interface Cursor {
  readonly uri: vscode.Uri;
  readonly line: number;
}

/**
 * Webview view provider of the side mini graph. It only works while visible:
 * hidden, it ignores the editor and the graph changes.
 */
export class MiniGraphViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private mode: MiniMode;
  private ready = false;
  /** Increases on every render request; older async renders are dropped. */
  private renderToken = 0;
  /** Last message sent, to skip identical updates. */
  private lastSent = '';
  private readonly follow = new EditorSyncScheduler<vscode.Uri>(() => {
    void this.render();
  }, FOLLOW_DELAY_MS);
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Creates the provider and starts listening to the editor and the graph.
   *
   * @param extensionUri - Root URI of the extension.
   * @param source - Graph access.
   * @param workspaceState - Where the chosen mode is kept.
   */
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: MiniGraphSource,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.mode = workspaceState.get<MiniMode>(MODE_KEY) === 'functions' ? 'functions' : 'files';
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.scheduleRender();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.scheduleRender();
        }
      }),
      source.onDidChangeGraph(() => {
        this.scheduleRender();
      }),
    );
  }

  /**
   * Called by VS Code the first time the view is shown.
   *
   * @param webviewView - View to fill.
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.ready = false;
    this.lastSent = '';
    const distUri = vscode.Uri.joinPath(this.extensionUri, ...WEBVIEW_DIST_SEGMENTS);
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    /**
     * Webview URI of a bundled asset.
     *
     * @param name - File name in `dist/webview`.
     * @returns The URI string.
     */
    const asset = (name: string): string =>
      webviewView.webview.asWebviewUri(vscode.Uri.joinPath(distUri, name)).toString();
    webviewView.webview.html = buildWebviewHtml({
      scriptUri: asset('mini.js'),
      styleUri: asset('mini.css'),
      cspSource: webviewView.webview.cspSource,
      nonce: createNonce(),
    });
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message);
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.lastSent = '';
          void this.render();
        }
      }),
      webviewView.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
      }),
    );
  }

  /** Releases the listeners. */
  public dispose(): void {
    this.follow.cancel();
    this.disposables.forEach((disposable) => {
      disposable.dispose();
    });
  }

  /**
   * Handles a message from the view.
   *
   * @param message - Raw payload (validated here).
   */
  private async handleMessage(message: unknown): Promise<void> {
    if (!isMiniViewToHostMessage(message)) {
      return;
    }
    switch (message.type) {
      case 'mini/ready':
        this.ready = true;
        this.lastSent = '';
        await this.render();
        return;
      case 'mini/mode':
        this.mode = message.mode;
        await this.workspaceState.update(MODE_KEY, message.mode);
        await this.render();
        return;
      case 'mini/open': {
        const node = this.source.getGraph()?.nodes.find((item) => item.id === message.nodeId);
        if (node !== undefined) {
          await this.source.openInEditor(node.filePath, node.line);
        }
        return;
      }
      case 'mini/graph':
        await this.source.showInGraph(message.nodeId);
        return;
    }
  }

  /** Re-renders after the cursor has been still for a moment. */
  private scheduleRender(): void {
    if (this.view?.visible !== true || !this.ready) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    // The scheduler only needs a location to debounce; render() reads the editor again.
    this.follow.schedule({
      uri: editor?.document.uri ?? this.extensionUri,
      line: (editor?.selection.active.line ?? 0) + 1,
    });
  }

  /**
   * Current cursor in a text editor, if any.
   *
   * @returns The cursor, or `undefined` without an active editor.
   */
  private cursor(): Cursor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.document.uri.scheme === 'output') {
      return undefined;
    }
    return { uri: editor.document.uri, line: editor.selection.active.line + 1 };
  }

  /** Computes what to show for the active editor and sends it to the view. */
  private async render(): Promise<void> {
    if (this.view?.visible !== true || !this.ready) {
      return;
    }
    const token = ++this.renderToken;
    const mode = this.mode;
    /**
     * Builds an empty-state message.
     *
     * @param reason - Why there is nothing to draw.
     * @returns The message.
     */
    const empty = (reason: MiniEmptyReason): MiniHostToView => ({
      type: 'mini/empty',
      mode,
      reason,
    });
    if (!this.source.hasFolders()) {
      await this.send(empty('no-folder'));
      return;
    }
    const cursor = this.cursor();
    if (cursor === undefined) {
      await this.send(empty('no-editor'));
      return;
    }
    let snapshot = this.source.getGraph();
    if (snapshot === null) {
      await this.send(empty('analyzing'));
      try {
        snapshot = await this.source.ensureGraph();
      } catch {
        snapshot = null;
      }
      if (token !== this.renderToken) {
        return;
      }
      if (snapshot === null) {
        await this.send(empty('error'));
        return;
      }
    }
    const filePath = this.source.toRelPath(cursor.uri);
    const nodeId = filePath === null ? null : resolveFocusTarget(snapshot, filePath, cursor.line);
    if (nodeId === null) {
      await this.send(empty('not-in-graph'));
      return;
    }
    const graph = computeMiniGraph(snapshot, nodeId, mode, undefined, this.source.getChangedIds());
    if (graph === null) {
      await this.send(empty(mode === 'functions' ? 'no-function' : 'not-in-graph'));
      return;
    }
    const details =
      graph.mode === 'functions' ? await this.source.readFunctionDetails(graph.center.id) : null;
    if (token !== this.renderToken) {
      return;
    }
    await this.send({ type: 'mini/graph', graph: { ...graph, details } });
  }

  /**
   * Posts a message to the view unless it repeats the last one.
   *
   * @param message - Message to deliver.
   */
  private async send(message: MiniHostToView): Promise<void> {
    const json = JSON.stringify(message);
    if (json === this.lastSent || this.view === undefined) {
      return;
    }
    this.lastSent = json;
    await this.view.webview.postMessage(message);
  }
}
