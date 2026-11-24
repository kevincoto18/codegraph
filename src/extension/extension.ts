import * as vscode from 'vscode';

import type { GraphSnapshot } from '../shared';

import { CodeGraphController } from './controller';
import { VIEW_TYPE } from './panel';
import { createOpenGraphStatusBarItem } from './statusBar';

/** Command identifier contributed in `package.json`. */
const OPEN_GRAPH_COMMAND = 'codegraph.openGraph';

/** Command that opens the graph focused on a file or function. */
const SHOW_CONNECTIONS_COMMAND = 'codegraph.showConnections';

/** Command that opens the performance report. */
const PERFORMANCE_REPORT_COMMAND = 'codegraph.showPerformanceReport';

/** Name of the output channel used for all extension logs. */
const LOG_CHANNEL_NAME = 'CodeGraph';

/**
 * Read-only API returned by {@link activate}, used by the integration tests
 * (and available to other extensions).
 */
export interface CodeGraphApi {
  /** Graph currently shown, or `null` before the first scan. */
  getGraph(): GraphSnapshot | null;
}

/** Controller of the running extension, released in {@link deactivate}. */
let activeController: CodeGraphController | undefined;

/**
 * Entry point called by VS Code when the extension is activated.
 *
 * Creates the log channel and the controller, registers the command (bound to
 * Ctrl+Alt+G) and adds the "CodeGraph" status bar button.
 * Every disposable is pushed to `context.subscriptions` so VS Code releases it
 * on deactivation.
 *
 * @param context - Extension context provided by VS Code.
 * @returns The read-only CodeGraph API.
 */
export function activate(context: vscode.ExtensionContext): CodeGraphApi {
  const logger = vscode.window.createOutputChannel(LOG_CHANNEL_NAME, { log: true });
  const version: unknown = (context.extension.packageJSON as { version?: unknown }).version;
  const extensionVersion = typeof version === 'string' ? version : '0';
  const controller = new CodeGraphController(
    context.extensionUri,
    logger,
    { storageUri: context.storageUri, extensionVersion },
    context.workspaceState,
  );
  activeController = controller;

  context.subscriptions.push(
    logger,
    controller,
    vscode.commands.registerCommand(OPEN_GRAPH_COMMAND, () => {
      controller.openGraph();
    }),
    vscode.commands.registerCommand(SHOW_CONNECTIONS_COMMAND, (uri?: vscode.Uri) =>
      controller.showConnections(uri),
    ),
    vscode.commands.registerCommand(PERFORMANCE_REPORT_COMMAND, () =>
      controller.showPerformanceReport(),
    ),
    createOpenGraphStatusBarItem(OPEN_GRAPH_COMMAND),
    // Reopens the graph panel after a window reload, with the view it had.
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        controller.restorePanel(panel);
        return Promise.resolve();
      },
    }),
  );

  logger.info('CodeGraph activated.');
  return {
    getGraph: () => controller.getGraph(),
  };
}

/**
 * Called by VS Code when the extension is deactivated: waits until the parse
 * cache has been persisted, so the next session starts warm.
 *
 * @returns Resolves once the session is released.
 */
export async function deactivate(): Promise<void> {
  const controller = activeController;
  activeController = undefined;
  await controller?.closeSession();
}
