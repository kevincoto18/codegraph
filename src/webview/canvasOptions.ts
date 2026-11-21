/**
 * Rendering policies of the canvas: level of detail by zoom and minimap visibility.
 */
import { useViewportStore } from '@xyflow/react';

/** Below this zoom level nodes and edges are drawn in low detail. */
export const LOW_DETAIL_ZOOM = 0.4;

/** In `auto` mode the minimap is hidden above this many rendered nodes. */
export const MINIMAP_AUTO_MAX_NODES = 1500;

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
