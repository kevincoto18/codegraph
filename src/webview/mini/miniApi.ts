/**
 * Typed bridge between the side view and the extension host.
 */
import type { MiniHostToView, MiniViewToHost } from '../../shared';
import { isMiniHostToViewMessage } from '../../shared';

/** Subset of the API object injected by VS Code into webviews. */
interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Lazily acquired API instance (VS Code forbids acquiring it twice). */
let api: VsCodeApi | undefined;

/**
 * Sends a typed message to the extension host.
 *
 * @param message - Message to send.
 */
export function postMini(message: MiniViewToHost): void {
  api ??= acquireVsCodeApi();
  api.postMessage(message);
}

/**
 * Subscribes to messages from the extension host. Invalid payloads are dropped.
 *
 * @param listener - Called with every valid message.
 * @returns A function that removes the subscription.
 */
export function subscribeMini(listener: (message: MiniHostToView) => void): () => void {
  /**
   * Validates a raw `message` event and forwards it.
   *
   * @param event - Event dispatched by VS Code.
   */
  const handle = (event: MessageEvent<unknown>): void => {
    if (isMiniHostToViewMessage(event.data)) {
      listener(event.data);
    }
  };
  window.addEventListener('message', handle);
  return () => {
    window.removeEventListener('message', handle);
  };
}
