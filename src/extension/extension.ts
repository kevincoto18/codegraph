import * as vscode from 'vscode';

import { GraphService } from './graphService';
import { VsCodeWorkspaceReader } from './workspaceReader';

/** Command identifier contributed in `package.json`. */
const OPEN_GRAPH_COMMAND = 'codegraph.openGraph';

/** Name of the output channel used for all extension logs. */
const LOG_CHANNEL_NAME = 'CodeGraph';

/**
 * Entry point called by VS Code when the extension is activated.
 *
 * Registers the extension's commands and its log channel. Every disposable is
 * pushed to `context.subscriptions` so VS Code releases it on deactivation.
 *
 * @param context - Extension context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel(LOG_CHANNEL_NAME, { log: true });

  context.subscriptions.push(
    logger,
    vscode.commands.registerCommand(OPEN_GRAPH_COMMAND, () => handleOpenGraph(logger)),
  );

  logger.info('CodeGraph activated.');
}

/**
 * Handles the `CodeGraph: Open Graph` command.
 *
 * @remarks Phase 3: scans the first workspace folder and reports graph stats.
 * The webview panel replaces this behaviour in Phase 4.
 *
 * @param logger - Log channel used to trace command execution.
 */
async function handleOpenGraph(logger: vscode.LogOutputChannel): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    void vscode.window.showWarningMessage('CodeGraph: open a folder to analyze.');
    return;
  }

  const service = new GraphService(new VsCodeWorkspaceReader(folder.uri), logger);
  const startedAt = Date.now();
  try {
    const snapshot = await service.initialize();
    const files = snapshot.nodes.filter((node) => node.kind === 'file').length;
    const functions = snapshot.nodes.length - files;
    const calls = snapshot.edges.filter((edge) => edge.kind === 'call').length;
    const imports = snapshot.edges.length - calls;
    const summary = `${String(files)} files, ${String(functions)} functions, ${String(imports)} imports, ${String(calls)} calls (${String(Date.now() - startedAt)} ms)`;
    logger.info(`Graph built: ${summary}`);
    void vscode.window.showInformationMessage(`CodeGraph: ${summary}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Graph build failed: ${message}`);
    void vscode.window.showErrorMessage(`CodeGraph: analysis failed — ${message}`);
  }
}
