/**
 * Decides how the canvas nodes are recomputed when the graph or the view
 * settings change.
 */
import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import type { FolderTree } from './folders';
import { buildFlowGraph, preserveFilePositions } from './layout';
import { toFlowElements } from './toFlowElements';

/** Canvas elements together with the inputs they were computed from. */
export interface ViewLayoutState {
  readonly snapshot: GraphSnapshot;
  /** Ids of the collapsed files and folders. */
  readonly collapsedIds: ReadonlySet<string>;
  /** Folder hierarchy, or `null` when files are shown at the top level. */
  readonly folderTree: FolderTree | null;
  /** Incremented to request a full re-layout. */
  readonly layoutRequest: number;
  /** How the nodes were positioned: full layered layout or incremental merge. */
  readonly mode: 'full' | 'incremental';
  readonly nodes: CodeGraphFlowNode[];
  readonly edges: CodeGraphFlowEdge[];
}

/** Inputs of a layout computation. */
export interface ViewLayoutInputs {
  readonly snapshot: GraphSnapshot;
  readonly collapsedIds: ReadonlySet<string>;
  readonly folderTree: FolderTree | null;
  readonly layoutRequest: number;
}

/**
 * Checks whether a layout state was computed from the given inputs.
 *
 * @param state - Current layout state.
 * @param inputs - Current inputs.
 * @returns `true` if nothing needs to be recomputed.
 */
export function isViewLayoutCurrent(state: ViewLayoutState, inputs: ViewLayoutInputs): boolean {
  return (
    state.snapshot === inputs.snapshot &&
    state.collapsedIds === inputs.collapsedIds &&
    state.folderTree === inputs.folderTree &&
    state.layoutRequest === inputs.layoutRequest
  );
}

/**
 * Computes the canvas elements for the given inputs.
 *
 * A change of the snapshot alone (a live patch, which also rebuilds the
 * folder tree) keeps existing positions; collapsing/expanding, switching the
 * folder view or an explicit re-layout recomputes the whole layout.
 *
 * @param previous - Previous layout state, or `null` on first render.
 * @param inputs - Snapshot, collapsed containers, folder tree and re-layout counter.
 * @returns The new layout state.
 */
export function computeViewLayout(
  previous: ViewLayoutState | null,
  inputs: ViewLayoutInputs,
): ViewLayoutState {
  const { snapshot, collapsedIds, folderTree, layoutRequest } = inputs;
  const isIncremental =
    previous !== null &&
    previous.collapsedIds === collapsedIds &&
    previous.layoutRequest === layoutRequest &&
    (previous.folderTree === null) === (folderTree === null);

  if (isIncremental) {
    const elements = toFlowElements(snapshot, collapsedIds, folderTree);
    return {
      ...inputs,
      mode: 'incremental',
      nodes: preserveFilePositions(elements, previous.nodes),
      edges: elements.edges,
    };
  }

  const { nodes, edges } = buildFlowGraph(snapshot, { collapsedIds, folderTree });
  return { ...inputs, mode: 'full', nodes, edges };
}
