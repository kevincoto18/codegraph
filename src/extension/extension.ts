import * as vscode from 'vscode';

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
    vscode.commands.registerCommand(OPEN_GRAPH_COMMAND, () => {
      handleOpenGraph(logger);
    }),
  );

  logger.info('CodeGraph activated.');
}

/**
 * Handles the `CodeGraph: Open Graph` command.
 *
 * @remarks Phase 0 placeholder: confirms the command wiring works. The
 * webview panel replaces this behaviour in Phase 4.
 *
 * @param logger - Log channel used to trace command execution.
 */
function handleOpenGraph(logger: vscode.LogOutputChannel): void {
  logger.info(`Command "${OPEN_GRAPH_COMMAND}" executed.`);
  void vscode.window.showInformationMessage('CodeGraph: scaffolding ready.');
}
