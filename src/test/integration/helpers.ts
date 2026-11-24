/**
 * Helpers shared by the integration tests, which run inside a real VS Code
 * window (see `.vscode-test.mjs`).
 */
import * as vscode from 'vscode';

import type { GraphSnapshot } from '../../shared';
import type { CodeGraphApi } from '../../extension/extension';

/** Longest wait for a graph or a tab, in milliseconds. */
const WAIT_TIMEOUT_MS = 90_000;

/** Polling interval, in milliseconds. */
const POLL_INTERVAL_MS = 200;

/**
 * Activates CodeGraph and returns its API.
 *
 * @returns The API.
 * @throws Error when the extension is not installed in the test window.
 */
export async function activateCodeGraph(): Promise<CodeGraphApi> {
  const extension = vscode.extensions.all.find(
    (candidate) => (candidate.packageJSON as { name?: unknown }).name === 'codegraph',
  );
  if (extension === undefined) {
    throw new Error('The CodeGraph extension is not loaded.');
  }
  return (await extension.activate()) as CodeGraphApi;
}

/**
 * Waits until a condition holds.
 *
 * @param condition - Checked every {@link POLL_INTERVAL_MS}.
 * @param description - What is awaited, for the timeout error (a function
 *   can add the current state to it).
 * @returns The first truthy value returned by the condition.
 * @throws Error after {@link WAIT_TIMEOUT_MS}.
 */
export async function waitFor<T>(
  condition: () => T | null | undefined | false,
  description: string | (() => string),
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = condition();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() - startedAt > WAIT_TIMEOUT_MS) {
      const text = typeof description === 'string' ? description : description();
      throw new Error(`Timed out waiting for ${text}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Waits for a graph that satisfies a condition.
 *
 * @param api - CodeGraph API.
 * @param condition - Condition on the graph.
 * @param description - What is awaited.
 * @returns The graph.
 */
export function waitForGraph(
  api: CodeGraphApi,
  condition: (graph: GraphSnapshot) => boolean,
  description: string,
): Promise<GraphSnapshot> {
  return waitFor(
    () => {
      const graph = api.getGraph();
      return graph !== null && condition(graph) ? graph : null;
    },
    () => `${description} (current graph: ${describeGraph(api.getGraph())})`,
  );
}

/**
 * Summarizes a graph for error messages.
 *
 * @param graph - Graph, or `null` before the first scan.
 * @returns E.g. `12 files: src/app.ts, …`.
 */
function describeGraph(graph: GraphSnapshot | null): string {
  if (graph === null) {
    return 'none yet';
  }
  const files = fileIds(graph);
  return `${String(files.length)} files${files.length > 0 ? `: ${files.slice(0, 5).join(', ')}` : ''}`;
}

/**
 * Finds the CodeGraph panel tab.
 *
 * @returns The tab and its group, or `undefined` when the panel is closed.
 */
export function findGraphTab(): { tab: vscode.Tab; group: vscode.TabGroup } | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.endsWith('codegraph.graph')
      ) {
        return { tab, group };
      }
    }
  }
  return undefined;
}

/**
 * Ids of the file nodes of a graph.
 *
 * @param graph - Graph.
 * @returns File ids.
 */
export function fileIds(graph: GraphSnapshot): string[] {
  return graph.nodes.filter((node) => node.kind === 'file').map((node) => node.id);
}

/** Closes every editor and panel, between tests. */
export async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
