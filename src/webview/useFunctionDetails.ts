/**
 * Asks the host for the signature and documentation of functions (hover
 * card) and keeps the answers until the graph changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { FunctionDetails } from '../shared';
import { postToHost, subscribeToHost } from './vscodeApi';

/** Details of a function: loaded (or `null` when unavailable), or not yet. */
export interface FunctionDetailsStore {
  /** Answers received, by node id. */
  readonly details: ReadonlyMap<string, FunctionDetails | null>;
  /** Asks for the details of a function once. */
  readonly request: (nodeId: string) => void;
}

/**
 * Loads function details on demand.
 *
 * @param resetKey - The answers are dropped when it changes (e.g. the graph).
 * @returns The answers and the request function.
 */
export function useFunctionDetails(resetKey: unknown): FunctionDetailsStore {
  const [store, setStore] = useState<{
    readonly key: unknown;
    readonly details: ReadonlyMap<string, FunctionDetails | null>;
  }>(() => ({ key: resetKey, details: new Map() }));
  const requested = useRef(new Set<string>());
  const nextRequestId = useRef(1);
  if (store.key !== resetKey) {
    // A new graph may have moved code: drop the answers…
    setStore({ key: resetKey, details: new Map() });
  }

  // …and allow asking again.
  useEffect(() => {
    requested.current = new Set();
  }, [resetKey]);

  useEffect(
    () =>
      subscribeToHost((message) => {
        if (message.type !== 'details') {
          return;
        }
        setStore((current) => ({
          key: current.key,
          details: new Map(current.details).set(message.nodeId, message.details),
        }));
      }),
    [],
  );

  const request = useCallback((nodeId: string) => {
    if (requested.current.has(nodeId)) {
      return;
    }
    requested.current.add(nodeId);
    postToHost({ type: 'details', requestId: nextRequestId.current, nodeId });
    nextRequestId.current += 1;
  }, []);

  return { details: store.details, request };
}
