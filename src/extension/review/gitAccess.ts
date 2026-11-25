/**
 * Access to the API of VS Code's built-in Git extension (`vscode.git`).
 */
import * as vscode from 'vscode';

import type { GitApi } from './gitChanges';

/** Git API with its initialization event. */
interface GitApiWithEvents extends GitApi {
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
}

/** Exports of the Git extension. */
interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitApiWithEvents;
}

/** How long to wait for the Git extension to find the repositories, in milliseconds. */
const INITIALIZATION_TIMEOUT_MS = 5000;

/**
 * Returns the Git API once the extension has found the repositories.
 *
 * @returns The API, or `null` when the Git extension is missing or disabled.
 */
export async function getGitApi(): Promise<GitApi | null> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (extension === undefined) {
    return null;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (!exports.enabled) {
    return null;
  }
  const api = exports.getAPI(1);
  if (api.state !== 'initialized') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        listener.dispose();
        resolve();
      }, INITIALIZATION_TIMEOUT_MS);
      const listener = api.onDidChangeState((state) => {
        if (state === 'initialized') {
          clearTimeout(timer);
          listener.dispose();
          resolve();
        }
      });
    });
  }
  return api;
}
