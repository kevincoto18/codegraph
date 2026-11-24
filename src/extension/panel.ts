/**
 * Webview panel that hosts the CodeGraph React application.
 */
import * as vscode from 'vscode';

import type { HostToWebview, WebviewToHost } from '../shared';
import { isWebviewToHostMessage } from '../shared';
import { buildWebviewHtml, createNonce } from './webviewHtml';

/** Identifier of the webview panel type. */
const VIEW_TYPE = 'codegraph.graph';

/** Title shown on the panel tab. */
const PANEL_TITLE = 'CodeGraph';

/** Path segments of the webview bundle inside the extension. */
const WEBVIEW_DIST_SEGMENTS = ['dist', 'webview'] as const;

/** Folder of the tab icons, relative to the extension root. */
const MEDIA_FOLDER = 'media';

/** Where a panel is shown. */
export interface PanelPlacement {
  /** Editor column of the panel. */
  readonly viewColumn: vscode.ViewColumn;
  /** Keep the keyboard focus where it is (e.g. in the editor). */
  readonly preserveFocus: boolean;
}

/** Default placement: the whole active editor area, focused. */
const FULL_EDITOR_PLACEMENT: PanelPlacement = {
  viewColumn: vscode.ViewColumn.Active,
  preserveFocus: false,
};

/** Receives validated messages sent by the webview. */
export type WebviewMessageHandler = (message: WebviewToHost) => void;

/** Logging surface used by the panel. */
interface PanelLogger {
  /** Logs a recoverable problem. */
  warn(message: string): void;
}

/**
 * Owns a `WebviewPanel`: renders its HTML, validates incoming messages and
 * sends typed messages to the webview.
 */
export class CodeGraphPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  /**
   * Wires an existing webview panel.
   *
   * @param panel - Underlying VS Code panel.
   * @param extensionUri - Root URI of the extension (to locate the bundle).
   * @param onMessage - Handler for validated webview messages.
   * @param onDispose - Called once when the panel is closed or disposed.
   * @param logger - Destination of protocol warnings.
   */
  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    onMessage: WebviewMessageHandler,
    onDispose: () => void,
    logger: PanelLogger,
  ) {
    this.panel.webview.html = this.renderHtml(extensionUri);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        if (isWebviewToHostMessage(raw)) {
          onMessage(raw);
        } else {
          logger.warn(`Ignored invalid webview message: ${JSON.stringify(raw)}`);
        }
      }),
      this.panel.onDidDispose(() => {
        this.dispose();
        onDispose();
      }),
    );
  }

  /** Editor column where the panel is shown, if visible. */
  public get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  /**
   * Creates and shows a new CodeGraph panel, with the CodeGraph icon on its tab.
   *
   * @param extensionUri - Root URI of the extension.
   * @param onMessage - Handler for validated webview messages.
   * @param onDispose - Called once when the panel is closed.
   * @param logger - Destination of protocol warnings.
   * @param placement - Column and focus; by default the whole active editor area.
   * @returns The new panel.
   */
  public static create(
    extensionUri: vscode.Uri,
    onMessage: WebviewMessageHandler,
    onDispose: () => void,
    logger: PanelLogger,
    placement: PanelPlacement = FULL_EDITOR_PLACEMENT,
  ): CodeGraphPanel {
    const webviewRoot = vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIST_SEGMENTS);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, placement, {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
      retainContextWhenHidden: false,
    });
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, MEDIA_FOLDER, 'codegraph-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, MEDIA_FOLDER, 'codegraph-dark.svg'),
    };
    return new CodeGraphPanel(panel, extensionUri, onMessage, onDispose, logger);
  }

  /**
   * Brings the panel to the front.
   *
   * @param placement - Column to move it to and whether to keep the focus
   *   where it is; by default it stays in its column and takes the focus.
   */
  public reveal(placement?: PanelPlacement): void {
    this.panel.reveal(placement?.viewColumn, placement?.preserveFocus);
  }

  /**
   * Sends a typed message to the webview.
   *
   * @param message - Message to deliver.
   * @returns Whether the message was delivered (false if the panel is gone).
   */
  public async post(message: HostToWebview): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    return this.panel.webview.postMessage(message);
  }

  /** Releases the panel and its listeners. Safe to call more than once. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.panel.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /**
   * Renders the webview document with URIs of the bundled assets.
   *
   * @param extensionUri - Root URI of the extension.
   * @returns The HTML document.
   */
  private renderHtml(extensionUri: vscode.Uri): string {
    return buildWebviewHtml({
      scriptUri: this.getAssetUri(extensionUri, 'index.js'),
      styleUri: this.getAssetUri(extensionUri, 'index.css'),
      cspSource: this.panel.webview.cspSource,
      nonce: createNonce(),
    });
  }

  /**
   * Resolves the webview URI of a file of the webview bundle.
   *
   * @param extensionUri - Root URI of the extension.
   * @param fileName - File name inside `dist/webview`.
   * @returns The URI the webview can load.
   */
  private getAssetUri(extensionUri: vscode.Uri, fileName: string): string {
    const fileUri = vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIST_SEGMENTS, fileName);
    return this.panel.webview.asWebviewUri(fileUri).toString();
  }
}
