/**
 * React hook that connects the webview UI to the extension host.
 */
import { useCallback, useEffect, useReducer } from 'react';

import type { RelPath } from '../shared';
import type { GraphChannelState } from './graphChannel';
import { INITIAL_GRAPH_CHANNEL_STATE, reduceHostMessage } from './graphChannel';
import { postToHost, subscribeToHost } from './vscodeApi';

/** State and actions exposed to the UI. */
export interface GraphChannel extends GraphChannelState {
  /** Asks the host for a full rescan. */
  readonly refresh: () => void;
  /** Asks the host to open a file at a 1-based line. */
  readonly navigate: (filePath: RelPath, line: number) => void;
}

/**
 * Subscribes to host messages, performs the `ready` handshake on mount and
 * exposes the graph state plus host actions.
 *
 * @returns The channel state and actions.
 */
export function useGraphChannel(): GraphChannel {
  const [state, dispatch] = useReducer(reduceHostMessage, INITIAL_GRAPH_CHANNEL_STATE);

  useEffect(() => {
    const unsubscribe = subscribeToHost(dispatch);
    postToHost({ type: 'ready' });
    return unsubscribe;
  }, []);

  const refresh = useCallback(() => {
    postToHost({ type: 'refresh' });
  }, []);

  const navigate = useCallback((filePath: RelPath, line: number) => {
    postToHost({ type: 'navigate', filePath, line });
  }, []);

  return { ...state, refresh, navigate };
}
