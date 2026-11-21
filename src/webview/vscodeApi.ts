/**
 * Typed bridge between the webview and the extension host.
 */
import type { HostToWebview, WebviewToHost } from '../shared';
import { isHostToWebviewMessage } from '../shared';

/** Subset of the API object injected by VS Code into webviews. */
interface VsCodeApi {
  /** Sends a message to the extension host. */
  postMessage(message: unknown): void;
}

declare global {
  /**
   * Returns the VS Code webview API. Can be called only once per webview session.
   */
  function acquireVsCodeApi(): VsCodeApi;
}

/** Lazily acquired API instance (VS Code forbids acquiring it twice). */
let vsCodeApi: VsCodeApi | undefined;

/**
 * Returns the VS Code API, acquiring it on first use.
 *
 * @returns The webview API object.
 */
function getVsCodeApi(): VsCodeApi {
  vsCodeApi ??= acquireVsCodeApi();
  return vsCodeApi;
}

/**
 * Sends a typed message to the extension host.
 *
 * @param message - Message to send.
 */
export function postToHost(message: WebviewToHost): void {
  getVsCodeApi().postMessage(message);
}

/**
 * Subscribes to messages from the extension host. Invalid payloads are dropped.
 *
 * @param listener - Called with every valid message.
 * @returns A function that removes the subscription.
 */
export function subscribeToHost(listener: (message: HostToWebview) => void): () => void {
  /**
   * Validates a raw `message` event and forwards it to the listener.
   *
   * @param event - Event dispatched by VS Code.
   */
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (isHostToWebviewMessage(event.data)) {
      listener(event.data);
    } else {
      console.warn('CodeGraph: ignored invalid host message', event.data);
    }
  };
  window.addEventListener('message', handleMessage);
  return () => {
    window.removeEventListener('message', handleMessage);
  };
}
