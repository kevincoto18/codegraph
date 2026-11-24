/**
 * React hook that connects the webview UI to the extension host.
 */
import { useCallback, useEffect, useReducer } from 'react';

import type { RelPath, ViewPreferences } from '../shared';
import type { GraphChannelState } from './graphChannel';
import { INITIAL_GRAPH_CHANNEL_STATE, reduceHostMessage } from './graphChannel';
import { SnapshotAssembler } from './snapshotAssembler';
import { postToHost, subscribeToHost } from './vscodeApi';

/** State and actions exposed to the UI. */
export interface GraphChannel extends GraphChannelState {
  /** Asks the host for a full rescan. */
  readonly refresh: () => void;
  /** Asks the host to open a file at a 1-based line. */
  readonly navigate: (filePath: RelPath, line: number) => void;
  /** Asks the host to store new view preferences for the workspace. */
  readonly savePreferences: (preferences: ViewPreferences) => void;
}

/**
 * Subscribes to host messages, performs the `ready` handshake on mount,
 * requests a resync when patches are missed and exposes the graph state plus
 * host actions.
 *
 * @returns The channel state and actions.
 */
export function useGraphChannel(): GraphChannel {
  const [state, dispatch] = useReducer(reduceHostMessage, INITIAL_GRAPH_CHANNEL_STATE);

  useEffect(() => {
    // Graph parts are collected outside the reducer, which only sees whole snapshots.
    const assembler = new SnapshotAssembler();
    const unsubscribe = subscribeToHost((message) => {
      if (message.type !== 'graph/init') {
        dispatch(message);
        return;
      }
      const graph = assembler.accept(message);
      if (graph !== null) {
        dispatch({ type: 'graph/loaded', graph });
      }
    });
    postToHost({ type: 'ready' });
    return unsubscribe;
  }, []);

  // A missed patch makes the local graph unreliable: ask the host to resend
  // its current snapshot (`ready` returns it without rescanning).
  useEffect(() => {
    if (state.outOfSync) {
      postToHost({ type: 'ready' });
    }
  }, [state.outOfSync]);

  const refresh = useCallback(() => {
    postToHost({ type: 'refresh' });
  }, []);

  const navigate = useCallback((filePath: RelPath, line: number) => {
    postToHost({ type: 'navigate', filePath, line });
  }, []);

  const savePreferences = useCallback((preferences: ViewPreferences) => {
    postToHost({ type: 'preferences', preferences });
  }, []);

  return { ...state, refresh, navigate, savePreferences };
}
