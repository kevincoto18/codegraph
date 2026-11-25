/**
 * Pure state management for messages received from the extension host.
 */
import type {
  AnalysisState,
  GraphSnapshot,
  HostToWebview,
  ViewOptions,
  ViewPreferences,
} from '../shared';
import { applyPatch, classifyPatch, getChangedNodeIds } from './patch';

/** Nodes touched by the latest applied patch (for visual feedback). */
export interface GraphChange {
  /** Version produced by the patch. */
  readonly version: number;
  /** Ids of new or meaningfully changed nodes. */
  readonly nodeIds: ReadonlySet<string>;
}

/**
 * Actions handled by {@link reduceHostMessage}: host messages, except the
 * chunked `graph/init` parts, which are replaced by one `graph/loaded` action
 * once the whole snapshot has been reassembled.
 */
export type GraphChannelAction =
  | Exclude<HostToWebview, { readonly type: 'graph/init' }>
  | { readonly type: 'graph/loaded'; readonly graph: GraphSnapshot };

/** Webview-side state derived from host messages. */
export interface GraphChannelState {
  /** Latest graph, or `null` before the first full snapshot. */
  readonly snapshot: GraphSnapshot | null;
  /** Current analysis status. */
  readonly status: AnalysisState;
  /** Error text when `status` is `error`. */
  readonly errorMessage: string | null;
  /** Incremented on every full snapshot; the view resets its state when it changes. */
  readonly sessionId: number;
  /** `true` when a patch was missed and a full resync must be requested. */
  readonly outOfSync: boolean;
  /** Latest applied patch, or `null` right after a full snapshot. */
  readonly lastChange: GraphChange | null;
  /** View preferences from the extension settings. */
  readonly options: ViewOptions;
  /** Latest focus asked by the host, numbered so repeated requests are distinct. */
  readonly focusRequest: FocusRequest | null;
  /** Latest node to highlight because the editor cursor is on it (editor sync). */
  readonly revealRequest: RevealRequest | null;
  /** Stored view preferences, or `null` until the host sends them. */
  readonly preferences: ViewPreferences | null;
}

/** A focus asked by the host. */
export interface FocusRequest {
  readonly nodeId: string;
  /** Increases with every request. */
  readonly sequence: number;
}

/** A node to highlight because the editor cursor is on it; numbered like {@link FocusRequest}. */
export type RevealRequest = FocusRequest;

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
  sessionId: 0,
  outOfSync: false,
  lastChange: null,
  options: { collapseMode: 'always', folderViewMode: 'auto', scrollBehavior: 'auto' },
  focusRequest: null,
  revealRequest: null,
  preferences: null,
};

/** Fallback text when the host reports an error without a message. */
const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

/**
 * Applies a host action to the channel state.
 *
 * @param state - Current state.
 * @param message - Validated host message or reassembled snapshot.
 * @returns The next state.
 */
export function reduceHostMessage(
  state: GraphChannelState,
  message: GraphChannelAction,
): GraphChannelState {
  switch (message.type) {
    case 'graph/loaded':
      return {
        ...state,
        snapshot: message.graph,
        status: 'ready',
        errorMessage: null,
        sessionId: state.sessionId + 1,
        outOfSync: false,
        lastChange: null,
      };
    case 'options':
      return { ...state, options: message.options };
    case 'focus':
      return {
        ...state,
        focusRequest: {
          nodeId: message.nodeId,
          sequence: (state.focusRequest?.sequence ?? 0) + 1,
        },
      };
    case 'reveal':
      return {
        ...state,
        revealRequest: {
          nodeId: message.nodeId,
          sequence: (state.revealRequest?.sequence ?? 0) + 1,
        },
      };
    case 'preferences':
      return { ...state, preferences: message.preferences };
    case 'status':
      return {
        ...state,
        status: message.state,
        errorMessage: message.state === 'error' ? (message.message ?? UNKNOWN_ERROR_MESSAGE) : null,
      };
    case 'graph/patch':
      return reducePatch(state, message.patch);
  }
}

/**
 * Applies a patch if it directly follows the current snapshot; flags a resync
 * if patches were missed; ignores stale patches.
 *
 * @param state - Current state.
 * @param patch - Incoming patch.
 * @returns The next state.
 */
function reducePatch(
  state: GraphChannelState,
  patch: Parameters<typeof applyPatch>[1],
): GraphChannelState {
  if (state.snapshot === null || state.outOfSync) {
    return state;
  }
  switch (classifyPatch(state.snapshot, patch)) {
    case 'stale':
      return state;
    case 'gap':
      return { ...state, outOfSync: true };
    case 'next':
      return {
        ...state,
        snapshot: applyPatch(state.snapshot, patch),
        lastChange: { version: patch.version, nodeIds: getChangedNodeIds(state.snapshot, patch) },
      };
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
