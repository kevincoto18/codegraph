/**
 * Integration tests on `samples/demo-project` (one workspace folder): the
 * commands, the graph panel, Show Connections and live updates, in a real
 * VS Code window.
 */
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import type { CodeGraphApi } from '../../extension/extension';
import {
  activateCodeGraph,
  closeAll,
  fileIds,
  findGraphTab,
  waitFor,
  waitForGraph,
} from './helpers';

suite('CodeGraph in a single-folder workspace', () => {
  let api: CodeGraphApi;

  suiteSetup(async () => {
    api = await activateCodeGraph();
  });

  teardown(async () => {
    await closeAll();
  });

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'codegraph.openGraph',
      'codegraph.showConnections',
      'codegraph.showPerformanceReport',
    ]) {
      assert.ok(commands.includes(command), `missing command ${command}`);
    }
  });

  test('Open Graph shows the panel and builds the graph', async () => {
    await vscode.commands.executeCommand('codegraph.openGraph');
    await waitFor(() => findGraphTab(), 'the CodeGraph tab');
    const graph = await waitForGraph(
      api,
      (candidate) => fileIds(candidate).includes('src/app.ts'),
      'the demo graph',
    );
    assert.ok(fileIds(graph).includes('src/services/userService.ts'));
    assert.ok(graph.edges.some((edge) => edge.kind === 'call'));
    assert.equal(findGraphTab()?.tab.label, 'CodeGraph');
  });

  test('Show Connections opens the graph beside the editor and keeps the focus in the code', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder !== undefined);
    const uri = vscode.Uri.joinPath(folder.uri, 'src', 'app.ts');
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('codegraph.showConnections', uri);
    const { group } = await waitFor(() => findGraphTab(), 'the CodeGraph tab');
    assert.notEqual(group.viewColumn, editor.viewColumn, 'the graph should open in another column');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString());
  });

  test('updates the graph when a file is created and deleted', async () => {
    await vscode.commands.executeCommand('codegraph.openGraph');
    await waitForGraph(api, (graph) => graph.nodes.length > 0, 'the demo graph');
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder !== undefined);
    const uri = vscode.Uri.joinPath(folder.uri, 'src', 'integrationProbe.ts');
    try {
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode('export function probe(): number {\n  return 1;\n}\n'),
      );
      await waitForGraph(
        api,
        (graph) => fileIds(graph).includes('src/integrationProbe.ts'),
        'the created file in the graph',
      );
    } finally {
      await vscode.workspace.fs.delete(uri);
    }
    await waitForGraph(
      api,
      (graph) => !fileIds(graph).includes('src/integrationProbe.ts'),
      'the deleted file to leave the graph',
    );
  });
});
