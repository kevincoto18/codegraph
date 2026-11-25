/**
 * Typed `postMessage` protocol between the extension host and the webview,
 * plus runtime guards to validate incoming messages.
 *
 * @remarks `postMessage` carries untyped data at runtime, so every receiver
 * must validate a message with the matching guard before using it.
 */
import type { ViewPreferences } from './preferences';
import { isViewPreferences } from './preferences';
import type { GraphPatch, GraphSnapshot, RelPath } from './types';
import type { ChunkLimits, WireGraphChunk } from './wire';
import { DEFAULT_CHUNK_LIMITS, encodeSnapshot } from './wire';

/** Analysis status reported by the host. */
export type AnalysisState = 'analyzing' | 'ready' | 'error';

/** Whether file containers start collapsed. */
export type CollapseMode = 'always' | 'auto' | 'never';

/** Whether the graph is shown as nested folders. */
export type FolderViewMode = 'always' | 'auto' | 'never';

/**
 * What scrolling with two fingers or the mouse wheel does: `auto` zooms with a
 * mouse wheel and pans with a touchpad, `pan` always pans and `zoom` always
 * zooms. Pinching and Ctrl + wheel always zoom.
 */
export type ScrollBehavior = 'auto' | 'pan' | 'zoom';

/** View preferences chosen in the extension settings. */
export interface ViewOptions {
  /** Initial collapse state of file containers. */
  readonly collapseMode: CollapseMode;
  /** Whether files are grouped into folder containers. */
  readonly folderViewMode: FolderViewMode;
  /** What the mouse wheel and two-finger scrolling do. */
  readonly scrollBehavior: ScrollBehavior;
  /**
   * Top-level folder names of the workspace folders when several are open
   * (multi-root), in workspace order; empty with a single folder.
   */
  readonly workspaceRoots: readonly string[];
}

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | GraphInitMessage
  | { readonly type: 'graph/patch'; readonly patch: GraphPatch }
  | { readonly type: 'status'; readonly state: AnalysisState; readonly message?: string }
  | { readonly type: 'options'; readonly options: ViewOptions }
  /** Focus a file or function (e.g. from "Show Connections"). */
  | { readonly type: 'focus'; readonly nodeId: string }
  /** Highlight and center the file or function under the editor cursor (editor sync). */
  | { readonly type: 'reveal'; readonly nodeId: string }
  /** Stored view preferences of the workspace. */
  | { readonly type: 'preferences'; readonly preferences: ViewPreferences }
  /** Answer to a `details` request: signature and documentation of a function. */
  | {
      readonly type: 'details';
      readonly requestId: number;
      readonly nodeId: string;
      readonly details: FunctionDetails | null;
    };

/** Signature and documentation of a function, read from its source. */
export interface FunctionDetails {
  /** Declaration line(s), whitespace collapsed (e.g. `save(user: User): void`). */
  readonly signature: string;
  /** First paragraph of its doc comment or docstring, if any. */
  readonly doc: string | null;
}

/** Longest signature or doc text accepted in a `details` message. */
export const MAX_DETAILS_TEXT = 2000;

/**
 * One part of a full graph. A graph is sent as a sequence of these messages
 * (`index` 0, 1, …) and the receiver rebuilds it when `last` arrives.
 */
export interface GraphInitMessage {
  readonly type: 'graph/init';
  /** Version of the snapshot being sent. */
  readonly version: number;
  /** 0-based position of this part. */
  readonly index: number;
  /** Whether this is the final part. */
  readonly last: boolean;
  /** Encoded files and edges of this part. */
  readonly chunk: WireGraphChunk;
}

/**
 * Splits a snapshot into the `graph/init` messages that transport it.
 *
 * @param snapshot - Graph to send.
 * @param limits - Chunk size limits.
 * @returns The messages, in sending order (at least one).
 */
export function createGraphInitMessages(
  snapshot: GraphSnapshot,
  limits: ChunkLimits = DEFAULT_CHUNK_LIMITS,
): GraphInitMessage[] {
  const chunks = encodeSnapshot(snapshot, limits);
  return chunks.map((chunk, index) => ({
    type: 'graph/init',
    version: snapshot.version,
    index,
    last: index === chunks.length - 1,
    chunk,
  }));
}

/** Messages sent from the webview to the extension host. */
export type WebviewToHost =
  /** Handshake: the webview has mounted and can receive the graph. */
  | { readonly type: 'ready' }
  /** Request to open a file and place the cursor at a 1-based line. */
  | { readonly type: 'navigate'; readonly filePath: RelPath; readonly line: number }
  /** Asks for the signature and documentation of a function (hover card). */
  | { readonly type: 'details'; readonly requestId: number; readonly nodeId: string }
  /** Request a full re-scan of the workspace. */
  | { readonly type: 'refresh' }
  /** Performance samples measured in the webview (milliseconds). */
  | { readonly type: 'metrics'; readonly samples: readonly MetricSample[] }
  /** The user changed the view preferences; the host persists them. */
  | { readonly type: 'preferences'; readonly preferences: ViewPreferences };

/** One performance measurement taken in the webview. */
export interface MetricSample {
  /** Metric name, e.g. `layout.full`. */
  readonly name: string;
  /** Duration in milliseconds. */
  readonly value: number;
}

/** Maximum number of samples accepted in one `metrics` message. */
export const MAX_METRIC_SAMPLES = 100;

/** All valid analysis states, used for runtime validation. */
const ANALYSIS_STATES: readonly AnalysisState[] = ['analyzing', 'ready', 'error'];

/** All valid collapse modes, used for runtime validation. */
export const COLLAPSE_MODES: readonly CollapseMode[] = ['always', 'auto', 'never'];

/** All valid folder view modes, used for runtime validation. */
export const FOLDER_VIEW_MODES: readonly FolderViewMode[] = ['always', 'auto', 'never'];

/** Most workspace folders accepted in an `options` message. */
export const MAX_WORKSPACE_ROOTS = 256;

/** Every valid {@link ScrollBehavior}. */
export const SCROLL_BEHAVIORS: readonly ScrollBehavior[] = ['auto', 'pan', 'zoom'];

/**
 * Checks a list of workspace folder names (non-empty, without `/`).
 *
 * @param value - Value to inspect.
 * @returns `true` for a valid list.
 */
function isWorkspaceRootList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_WORKSPACE_ROOTS &&
    value.every((root) => typeof root === 'string' && root !== '' && !root.includes('/'))
  );
}

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
 * Checks whether a value is a valid metric sample.
 *
 * @param value - Value to inspect.
 * @returns `true` for `{ name: non-empty string, value: finite number >= 0 }`.
 */
function isMetricSample(value: unknown): value is MetricSample {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    value.value >= 0
  );
}

/**
 * Shallow structural check of an encoded graph chunk.
 *
 * @param value - Value to inspect.
 * @returns `true` if the value has file and edge arrays.
 */
function isGraphChunkLike(value: unknown): value is WireGraphChunk {
  return isRecord(value) && Array.isArray(value.files) && Array.isArray(value.edges);
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
    case 'metrics':
      return (
        Array.isArray(value.samples) &&
        value.samples.length <= MAX_METRIC_SAMPLES &&
        value.samples.every(isMetricSample)
      );
    case 'preferences':
      return isViewPreferences(value.preferences);
    case 'details':
      return (
        isPositiveInteger(value.requestId) &&
        typeof value.nodeId === 'string' &&
        value.nodeId.length > 0
      );
    default:
      return false;
  }
}

/**
 * Checks the details of a function sent by the host.
 *
 * @param value - Value to inspect.
 * @returns `true` for valid details or `null`.
 */
function isFunctionDetailsOrNull(value: unknown): value is FunctionDetails | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.signature === 'string' &&
      value.signature.length <= MAX_DETAILS_TEXT &&
      (value.doc === null ||
        (typeof value.doc === 'string' && value.doc.length <= MAX_DETAILS_TEXT)))
  );
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
      return (
        isPositiveInteger(value.version) &&
        typeof value.index === 'number' &&
        Number.isInteger(value.index) &&
        value.index >= 0 &&
        typeof value.last === 'boolean' &&
        isGraphChunkLike(value.chunk)
      );
    case 'graph/patch':
      return isGraphPatchLike(value.patch);
    case 'options':
      return (
        isRecord(value.options) &&
        COLLAPSE_MODES.includes(value.options.collapseMode as CollapseMode) &&
        FOLDER_VIEW_MODES.includes(value.options.folderViewMode as FolderViewMode) &&
        SCROLL_BEHAVIORS.includes(value.options.scrollBehavior as ScrollBehavior) &&
        isWorkspaceRootList(value.options.workspaceRoots)
      );
    case 'focus':
    case 'reveal':
      return typeof value.nodeId === 'string' && value.nodeId !== '';
    case 'preferences':
      return isViewPreferences(value.preferences);
    case 'details':
      return (
        isPositiveInteger(value.requestId) &&
        typeof value.nodeId === 'string' &&
        value.nodeId.length > 0 &&
        isFunctionDetailsOrNull(value.details)
      );
    case 'status':
      return (
        ANALYSIS_STATES.includes(value.state as AnalysisState) &&
        (value.message === undefined || typeof value.message === 'string')
      );
    default:
      return false;
  }
}
