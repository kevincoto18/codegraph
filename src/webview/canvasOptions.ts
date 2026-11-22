/**
 * Rendering policies of the canvas: level of detail by zoom and minimap visibility.
 */
import type { Viewport } from '@xyflow/react';
import { getViewportForBounds, useViewportStore } from '@xyflow/react';

import type { CodeGraphFlowNode } from './flowTypes';

/** Below this zoom level nodes and edges are drawn in low detail. */
export const LOW_DETAIL_ZOOM = 0.4;

/** In `auto` mode the minimap is hidden above this many rendered nodes. */
export const MINIMAP_AUTO_MAX_NODES = 1500;

/**
 * While zoomed out (low detail), edges are not drawn at all above this many:
 * at that distance they are indistinguishable, and inserting tens of
 * thousands of SVG paths at once takes React several seconds.
 */
export const LOW_DETAIL_MAX_EDGES = 3000;

/** Smallest zoom level, low enough to fit large projects. */
export const MIN_ZOOM = 0.02;

/** Highest zoom used when fitting the whole graph. */
const FIT_MAX_ZOOM = 1;

/** Margin around the graph when fitting it, as a fraction of the viewport. */
const FIT_PADDING = 0.1;

/** User choice for the minimap. */
export type MinimapPreference = 'auto' | 'on' | 'off';

/**
 * Decides whether a zoom level is low enough to simplify rendering.
 *
 * @param zoom - Current zoom factor.
 * @returns `true` below {@link LOW_DETAIL_ZOOM}.
 */
export function isLowDetailZoom(zoom: number): boolean {
  return zoom < LOW_DETAIL_ZOOM;
}

/**
 * React hook telling whether the canvas is zoomed out enough for low detail.
 *
 * @remarks The selector returns a boolean, so components re-render only when
 * the zoom crosses the threshold, not on every pan/zoom frame.
 *
 * @returns `true` while the canvas is in low-detail mode.
 */
export function useLowDetail(): boolean {
  return useViewportStore((state) => isLowDetailZoom(state.transform[2]));
}

/**
 * Computes the viewport that fits every top-level node, so the canvas mounts
 * directly at its final zoom. Letting React Flow fit the view after mounting
 * would first render at zoom 1 and then insert thousands of nodes into the
 * existing list, which React handles in quadratic time.
 *
 * @param nodes - Positioned nodes (children are inside their top-level parent).
 * @param width - Width of the canvas, in pixels.
 * @param height - Height of the canvas, in pixels.
 * @returns The viewport, or the identity viewport for an empty graph.
 */
export function computeFitViewport(
  nodes: readonly CodeGraphFlowNode[],
  width: number,
  height: number,
): Viewport {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.parentId !== undefined) {
      continue;
    }
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + (node.width ?? 0));
    maxY = Math.max(maxY, node.position.y + (node.height ?? 0));
  }
  if (!Number.isFinite(minX) || width <= 0 || height <= 0) {
    return { x: 0, y: 0, zoom: 1 };
  }
  return getViewportForBounds(
    { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    width,
    height,
    MIN_ZOOM,
    FIT_MAX_ZOOM,
    FIT_PADDING,
  );
}

/**
 * Decides whether edges are skipped at the current level of detail.
 *
 * @param lowDetail - Whether the canvas is zoomed out (see {@link useLowDetail}).
 * @param edgeCount - Number of edges to draw.
 * @returns `true` if no edge should be drawn.
 */
export function shouldHideEdges(lowDetail: boolean, edgeCount: number): boolean {
  return lowDetail && edgeCount > LOW_DETAIL_MAX_EDGES;
}

/**
 * Resolves whether the minimap is shown.
 *
 * @param preference - User choice.
 * @param nodeCount - Number of nodes in the canvas.
 * @returns `true` if the minimap should be rendered.
 */
export function shouldShowMinimap(preference: MinimapPreference, nodeCount: number): boolean {
  if (preference === 'auto') {
    return nodeCount <= MINIMAP_AUTO_MAX_NODES;
  }
  return preference === 'on';
}
