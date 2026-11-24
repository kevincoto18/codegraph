/**
 * Integration tests on a multi-root workspace (the Python and Go samples):
 * one graph shows every folder, each under a top-level folder named after it.
 */
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { activateCodeGraph, closeAll, fileIds, waitForGraph } from './helpers';

suite('CodeGraph in a multi-root workspace', () => {
  teardown(async () => {
    await closeAll();
  });

  test('shows every workspace folder in one graph', async () => {
    assert.equal(vscode.workspace.workspaceFolders?.length, 2);
    const api = await activateCodeGraph();
    await vscode.commands.executeCommand('codegraph.openGraph');
    const graph = await waitForGraph(
      api,
      (candidate) => {
        const files = fileIds(candidate);
        return files.includes('python-demo/app/main.py') && files.includes('go-demo/main.go');
      },
      'files of both folders',
    );
    // Links inside each folder still resolve with the folder prefix.
    assert.ok(
      graph.edges.some(
        (edge) => edge.kind === 'call' && edge.source.startsWith('go-demo/main.go#'),
      ),
    );
    assert.ok(
      graph.edges.some(
        (edge) => edge.kind === 'import' && edge.source === 'python-demo/app/main.py',
      ),
    );
  });
});
