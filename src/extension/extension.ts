import * as vscode from 'vscode';

import { CodeGraphController } from './controller';
import { createOpenGraphStatusBarItem } from './statusBar';

/** Command identifier contributed in `package.json`. */
const OPEN_GRAPH_COMMAND = 'codegraph.openGraph';

/** Name of the output channel used for all extension logs. */
const LOG_CHANNEL_NAME = 'CodeGraph';

/**
 * Entry point called by VS Code when the extension is activated.
 *
 * Creates the log channel and the controller, registers the command (bound to
 * Ctrl+Alt+G) and adds the "CodeGraph" status bar button.
 * Every disposable is pushed to `context.subscriptions` so VS Code releases it
 * on deactivation.
 *
 * @param context - Extension context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel(LOG_CHANNEL_NAME, { log: true });
  const controller = new CodeGraphController(context.extensionUri, logger);

  context.subscriptions.push(
    logger,
    controller,
    vscode.commands.registerCommand(OPEN_GRAPH_COMMAND, () => {
      controller.openGraph();
    }),
    createOpenGraphStatusBarItem(OPEN_GRAPH_COMMAND),
  );

  logger.info('CodeGraph activated.');
}
