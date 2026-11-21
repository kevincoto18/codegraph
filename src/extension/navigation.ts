/**
 * Opens source files at a given line in the editor.
 */
import * as vscode from 'vscode';

/**
 * Converts a 1-based model line into a valid 0-based editor line.
 *
 * @param line - 1-based line from the graph model.
 * @param lineCount - Number of lines in the document.
 * @returns A 0-based line clamped to the document bounds.
 */
export function toEditorLine(line: number, lineCount: number): number {
  return Math.min(Math.max(line - 1, 0), Math.max(lineCount - 1, 0));
}

/**
 * Opens a file and places the cursor at the first non-blank character of a line,
 * scrolling it to the center of the editor.
 *
 * @param uri - File to open.
 * @param line - 1-based target line.
 * @param viewColumn - Editor column to open the file in.
 */
export async function openFileAtLine(
  uri: vscode.Uri,
  line: number,
  viewColumn: vscode.ViewColumn,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editorLine = toEditorLine(line, document.lineCount);
  const character = document.lineAt(editorLine).firstNonWhitespaceCharacterIndex;
  const position = new vscode.Position(editorLine, character);
  const range = new vscode.Range(position, position);

  const editor = await vscode.window.showTextDocument(document, { viewColumn, selection: range });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
