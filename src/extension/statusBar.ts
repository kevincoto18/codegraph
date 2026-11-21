/**
 * Status bar entry that opens the graph with one click.
 *
 * @remarks Lives in the status bar because it is the only always-visible
 * place an extension can add a button to (the window title bar is not
 * extensible, and the editor title bar disappears when no file is open).
 */
import * as vscode from 'vscode';

/** Identifier of the status bar item (lets users hide/show it). */
const STATUS_BAR_ITEM_ID = 'codegraph.open';

/** Priority among left-aligned items; higher values sit further left. */
const STATUS_BAR_PRIORITY = 100;

/**
 * Creates the "CodeGraph" status bar button.
 *
 * @param commandId - Command executed on click.
 * @returns The visible status bar item (dispose it on deactivation).
 */
export function createOpenGraphStatusBarItem(commandId: string): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    STATUS_BAR_ITEM_ID,
    vscode.StatusBarAlignment.Left,
    STATUS_BAR_PRIORITY,
  );
  item.name = 'CodeGraph';
  item.text = '$(type-hierarchy) CodeGraph';
  item.tooltip = 'Open the CodeGraph view (Ctrl+Alt+G)';
  item.command = commandId;
  item.show();
  return item;
}
