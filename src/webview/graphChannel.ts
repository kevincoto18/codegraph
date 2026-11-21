/**
 * Pure state management for messages received from the extension host.
 */
import type { AnalysisState, GraphSnapshot, HostToWebview } from '../shared';

/** Webview-side state derived from host messages. */
export interface GraphChannelState {
  /** Latest graph, or `null` before the first `graph/init`. */
  readonly snapshot: GraphSnapshot | null;
  /** Current analysis status. */
  readonly status: AnalysisState;
  /** Error text when `status` is `error`. */
  readonly errorMessage: string | null;
}

/** Counters displayed in the status bar. */
export interface GraphSummary {
  readonly files: number;
  readonly functions: number;
  readonly imports: number;
  readonly calls: number;
}

/** State before the host answers the `ready` handshake. */
export const INITIAL_GRAPH_CHANNEL_STATE: GraphChannelState = {
  snapshot: null,
  status: 'analyzing',
  errorMessage: null,
};

/** Fallback text when the host reports an error without a message. */
const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

/**
 * Applies a host message to the channel state.
 *
 * @remarks `graph/patch` is applied incrementally in Phase 7; until then the
 * host only sends full snapshots, so patches leave the state unchanged.
 *
 * @param state - Current state.
 * @param message - Validated host message.
 * @returns The next state.
 */
export function reduceHostMessage(
  state: GraphChannelState,
  message: HostToWebview,
): GraphChannelState {
  switch (message.type) {
    case 'graph/init':
      return { snapshot: message.graph, status: 'ready', errorMessage: null };
    case 'status':
      return {
        ...state,
        status: message.state,
        errorMessage: message.state === 'error' ? (message.message ?? UNKNOWN_ERROR_MESSAGE) : null,
      };
    case 'graph/patch':
      return state;
  }
}

/**
 * Counts the nodes and edges of a snapshot by kind.
 *
 * @param snapshot - Graph snapshot.
 * @returns File, function, import and call counts.
 */
export function summarizeGraph(snapshot: GraphSnapshot): GraphSummary {
  const files = snapshot.nodes.filter((node) => node.kind === 'file').length;
  const imports = snapshot.edges.filter((edge) => edge.kind === 'import').length;
  return {
    files,
    functions: snapshot.nodes.length - files,
    imports,
    calls: snapshot.edges.length - imports,
  };
}
