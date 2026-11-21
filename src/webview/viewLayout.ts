/**
 * Decides how the canvas nodes are recomputed when the graph or the view
 * settings change.
 */
import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import { buildFlowGraph, preserveFilePositions } from './layout';
import { toFlowElements } from './toFlowElements';

/** Canvas elements together with the inputs they were computed from. */
export interface ViewLayoutState {
  readonly snapshot: GraphSnapshot;
  readonly collapsedFileIds: ReadonlySet<string>;
  /** Incremented to request a full re-layout. */
  readonly layoutRequest: number;
  readonly nodes: CodeGraphFlowNode[];
  readonly edges: CodeGraphFlowEdge[];
}

/**
 * Checks whether a layout state was computed from the given inputs.
 *
 * @param state - Current layout state.
 * @param snapshot - Current snapshot.
 * @param collapsedFileIds - Current collapsed files.
 * @param layoutRequest - Current re-layout counter.
 * @returns `true` if nothing needs to be recomputed.
 */
export function isViewLayoutCurrent(
  state: ViewLayoutState,
  snapshot: GraphSnapshot,
  collapsedFileIds: ReadonlySet<string>,
  layoutRequest: number,
): boolean {
  return (
    state.snapshot === snapshot &&
    state.collapsedFileIds === collapsedFileIds &&
    state.layoutRequest === layoutRequest
  );
}

/**
 * Computes the canvas elements for the given inputs.
 *
 * A change of the snapshot alone (a live patch) keeps existing file positions;
 * collapsing/expanding or an explicit re-layout recomputes the whole layout.
 *
 * @param previous - Previous layout state, or `null` on first render.
 * @param snapshot - Graph snapshot.
 * @param collapsedFileIds - Ids of collapsed files.
 * @param layoutRequest - Re-layout counter.
 * @returns The new layout state.
 */
export function computeViewLayout(
  previous: ViewLayoutState | null,
  snapshot: GraphSnapshot,
  collapsedFileIds: ReadonlySet<string>,
  layoutRequest: number,
): ViewLayoutState {
  const isIncremental =
    previous !== null &&
    previous.collapsedFileIds === collapsedFileIds &&
    previous.layoutRequest === layoutRequest;

  if (isIncremental) {
    const elements = toFlowElements(snapshot, collapsedFileIds);
    return {
      snapshot,
      collapsedFileIds,
      layoutRequest,
      nodes: preserveFilePositions(elements, previous.nodes),
      edges: elements.edges,
    };
  }

  const { nodes, edges } = buildFlowGraph(snapshot, { collapsedFileIds });
  return { snapshot, collapsedFileIds, layoutRequest, nodes, edges };
}
