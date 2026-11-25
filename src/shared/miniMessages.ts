/**
 * Protocol between the extension host and the "CodeGraph" side view (mini
 * graph in the Explorer), plus runtime guards for incoming messages.
 */
import type { FunctionDetails } from './messages';
import type { RelPath } from './types';

/** What the mini graph centers on: the active file or the function under the cursor. */
export type MiniMode = 'files' | 'functions';

/** Every valid {@link MiniMode}. */
export const MINI_MODES: readonly MiniMode[] = ['files', 'functions'];

/** How a neighbor is connected to the center. */
export type MiniRelation = 'import' | 'call' | 'both';

/** A node of the mini graph. */
export interface MiniNode {
  readonly id: string;
  readonly kind: 'file' | 'function';
  /** Name shown on the node (file name or qualified function name). */
  readonly label: string;
  /** Where it lives (folder for files, file for functions). */
  readonly detail: string;
  readonly filePath: RelPath;
  /** 1-based line to open. */
  readonly line: number;
  /** How it is connected to the center (neighbors only). */
  readonly relation?: MiniRelation;
  /** Number of connections with the center (neighbors only). */
  readonly weight?: number;
  /** Changed in the running change review (for a file: itself or one of its functions). */
  readonly changed?: boolean;
}

/** Neighborhood of the center. */
export interface MiniGraph {
  readonly mode: MiniMode;
  readonly center: MiniNode;
  /** Functions of the center file (files mode). */
  readonly members: readonly MiniNode[];
  /** Nodes that use the center, most connected first. */
  readonly incoming: readonly MiniNode[];
  /** Nodes the center uses, most connected first. */
  readonly outgoing: readonly MiniNode[];
  /** Neighbors left out of the lists (too many to draw). */
  readonly moreIncoming: number;
  readonly moreOutgoing: number;
  /** Function under the cursor, highlighted among the members (files mode). */
  readonly activeId: string | null;
  /** Signature and documentation of the center function (functions mode). */
  readonly details: FunctionDetails | null;
}

/** Why the mini graph has nothing to draw. */
export type MiniEmptyReason =
  'no-folder' | 'no-editor' | 'analyzing' | 'not-in-graph' | 'no-function' | 'error';

/** Messages from the host to the side view. */
export type MiniHostToView =
  | { readonly type: 'mini/graph'; readonly graph: MiniGraph }
  | { readonly type: 'mini/empty'; readonly mode: MiniMode; readonly reason: MiniEmptyReason };

/** Messages from the side view to the host. */
export type MiniViewToHost =
  | { readonly type: 'mini/ready' }
  /** Open a file or function in the editor. */
  | { readonly type: 'mini/open'; readonly nodeId: string }
  /** Switch between files and functions. */
  | { readonly type: 'mini/mode'; readonly mode: MiniMode }
  /** Open the full graph focused on a node. */
  | { readonly type: 'mini/graph'; readonly nodeId: string };

/**
 * Checks that a value is a plain object.
 *
 * @param value - Value to check.
 * @returns `true` for non-null objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a node id.
 *
 * @param value - Value to check.
 * @returns `true` for a non-empty string of reasonable length.
 */
function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

/**
 * Validates a message received by the host from the side view.
 *
 * @param value - Raw payload.
 * @returns `true` if it is a well-formed {@link MiniViewToHost} message.
 */
export function isMiniViewToHostMessage(value: unknown): value is MiniViewToHost {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'mini/ready':
      return true;
    case 'mini/open':
    case 'mini/graph':
      return isNodeId(value.nodeId);
    case 'mini/mode':
      return MINI_MODES.includes(value.mode as MiniMode);
    default:
      return false;
  }
}

/**
 * Validates a message received by the side view from the host (shallow:
 * the host is a trusted producer).
 *
 * @param value - Raw payload.
 * @returns `true` if it is a well-formed {@link MiniHostToView} message.
 */
export function isMiniHostToViewMessage(value: unknown): value is MiniHostToView {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'mini/graph':
      return (
        isRecord(value.graph) &&
        MINI_MODES.includes(value.graph.mode as MiniMode) &&
        isRecord(value.graph.center) &&
        Array.isArray(value.graph.incoming) &&
        Array.isArray(value.graph.outgoing) &&
        Array.isArray(value.graph.members)
      );
    case 'mini/empty':
      return MINI_MODES.includes(value.mode as MiniMode) && typeof value.reason === 'string';
    default:
      return false;
  }
}
