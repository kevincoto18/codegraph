/**
 * Typed `postMessage` protocol between the extension host and the webview,
 * plus runtime guards to validate incoming messages.
 *
 * @remarks `postMessage` carries untyped data at runtime, so every receiver
 * must validate a message with the matching guard before using it.
 */
import type { GraphPatch, GraphSnapshot, RelPath } from './types';

/** Analysis status reported by the host. */
export type AnalysisState = 'analyzing' | 'ready' | 'error';

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | { readonly type: 'graph/init'; readonly graph: GraphSnapshot }
  | { readonly type: 'graph/patch'; readonly patch: GraphPatch }
  | { readonly type: 'status'; readonly state: AnalysisState; readonly message?: string };

/** Messages sent from the webview to the extension host. */
export type WebviewToHost =
  /** Handshake: the webview has mounted and can receive the graph. */
  | { readonly type: 'ready' }
  /** Request to open a file and place the cursor at a 1-based line. */
  | { readonly type: 'navigate'; readonly filePath: RelPath; readonly line: number }
  /** Request a full re-scan of the workspace. */
  | { readonly type: 'refresh' };

/** All valid analysis states, used for runtime validation. */
const ANALYSIS_STATES: readonly AnalysisState[] = ['analyzing', 'ready', 'error'];

/**
 * Checks whether a value is a non-null, non-array object.
 *
 * @param value - Value to inspect.
 * @returns `true` if the value can be read as a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a value is a positive integer (valid 1-based line or version).
 *
 * @param value - Value to inspect.
 * @returns `true` if the value is an integer greater than or equal to 1.
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Shallow structural check of a graph snapshot.
 *
 * @param value - Value to inspect.
 * @returns `true` if the value has a valid version and node/edge arrays.
 */
function isGraphSnapshotLike(value: unknown): value is GraphSnapshot {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

/**
 * Shallow structural check of a graph patch.
 *
 * @param value - Value to inspect.
 * @returns `true` if the value has a valid version and all four change arrays.
 */
function isGraphPatchLike(value: unknown): value is GraphPatch {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    Array.isArray(value.upsertNodes) &&
    Array.isArray(value.removeNodeIds) &&
    Array.isArray(value.upsertEdges) &&
    Array.isArray(value.removeEdgeIds)
  );
}

/**
 * Validates a message received by the extension host from the webview.
 *
 * @param value - Raw payload received through `onDidReceiveMessage`.
 * @returns `true` if the payload is a well-formed {@link WebviewToHost} message.
 */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHost {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'ready':
    case 'refresh':
      return true;
    case 'navigate':
      return (
        typeof value.filePath === 'string' &&
        value.filePath.length > 0 &&
        isPositiveInteger(value.line)
      );
    default:
      return false;
  }
}

/**
 * Validates a message received by the webview from the extension host.
 *
 * @remarks Graph payloads are checked shallowly: the host is a trusted
 * producer, so this guards against protocol mistakes rather than attacks.
 *
 * @param value - Raw payload received through the `message` event.
 * @returns `true` if the payload is a well-formed {@link HostToWebview} message.
 */
export function isHostToWebviewMessage(value: unknown): value is HostToWebview {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'graph/init':
      return isGraphSnapshotLike(value.graph);
    case 'graph/patch':
      return isGraphPatchLike(value.patch);
    case 'status':
      return (
        ANALYSIS_STATES.includes(value.state as AnalysisState) &&
        (value.message === undefined || typeof value.message === 'string')
      );
    default:
      return false;
  }
}
