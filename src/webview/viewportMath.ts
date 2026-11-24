/**
 * Viewport arithmetic for "show this node" actions (search, editor sync,
 * focus mode), kept pure so it can be tested without a canvas.
 */

/** A rectangle in graph coordinates. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Size of the visible canvas, in screen pixels. */
export interface PaneSize {
  readonly width: number;
  readonly height: number;
}

/** React Flow viewport: screen offset and zoom. */
export interface ViewportState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Zoom used to show a function: its name is comfortably readable. */
export const FUNCTION_ZOOM = 1;

/** Zoom used to show a file or folder. */
export const CONTAINER_ZOOM = 0.8;

/** Lowest zoom for showing a focus at once; below it the view centers on the focused node. */
export const FOCUS_MIN_ZOOM = 0.75;

/** Screen margin kept around shown nodes, in pixels. */
export const VIEW_MARGIN = 32;

/**
 * Smallest box containing every box.
 *
 * @param boxes - Boxes to enclose (at least one).
 * @returns The enclosing box, or `null` for an empty list.
 */
export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) {
    return null;
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Viewport that puts a graph point at the center of the pane.
 *
 * @param pointX - Graph x coordinate.
 * @param pointY - Graph y coordinate.
 * @param pane - Pane size.
 * @param zoom - Zoom to use.
 * @returns The viewport.
 */
export function viewportCenteredOn(
  pointX: number,
  pointY: number,
  pane: PaneSize,
  zoom: number,
): ViewportState {
  return { x: pane.width / 2 - pointX * zoom, y: pane.height / 2 - pointY * zoom, zoom };
}

/**
 * Viewport that shows a node close up: centered, at least at `targetZoom`
 * (never zooming out), and with the top of a box taller than the pane at the
 * top of the screen so its header stays visible.
 *
 * @param box - Node box in graph coordinates.
 * @param pane - Pane size.
 * @param viewport - Current viewport.
 * @param targetZoom - Lowest zoom to show the node at.
 * @returns The new viewport, or `null` when the node is already fully visible at that zoom.
 */
export function viewportToShowBox(
  box: Box,
  pane: PaneSize,
  viewport: ViewportState,
  targetZoom: number,
): ViewportState | null {
  const left = box.x * viewport.zoom + viewport.x;
  const top = box.y * viewport.zoom + viewport.y;
  const fullyVisible =
    left >= VIEW_MARGIN &&
    top >= VIEW_MARGIN &&
    left + box.width * viewport.zoom <= pane.width - VIEW_MARGIN &&
    top + box.height * viewport.zoom <= pane.height - VIEW_MARGIN;
  if (fullyVisible && viewport.zoom >= targetZoom * 0.95) {
    return null;
  }
  const zoom = Math.max(viewport.zoom, targetZoom);
  // A box taller than the pane is shown from its top, not from its middle.
  const visibleHeight = (pane.height - 2 * VIEW_MARGIN) / zoom;
  const centerY = box.height <= visibleHeight ? box.y + box.height / 2 : box.y + visibleHeight / 2;
  return viewportCenteredOn(box.x + box.width / 2, centerY, pane, zoom);
}

/**
 * Viewport that fits boxes in the pane, or `null` when that would need a zoom
 * below `minZoom` (the caller then shows the main node close up instead).
 *
 * @param boxes - Boxes to show.
 * @param pane - Pane size.
 * @param minZoom - Lowest acceptable zoom.
 * @param maxZoom - Highest zoom.
 * @returns The fitted viewport, or `null`.
 */
export function viewportToFitBoxes(
  boxes: readonly Box[],
  pane: PaneSize,
  minZoom: number,
  maxZoom: number,
): ViewportState | null {
  const bounds = unionBoxes(boxes);
  if (bounds === null) {
    return null;
  }
  const zoom = Math.min(
    maxZoom,
    (pane.width - 2 * VIEW_MARGIN) / Math.max(bounds.width, 1),
    (pane.height - 2 * VIEW_MARGIN) / Math.max(bounds.height, 1),
  );
  if (zoom < minZoom) {
    return null;
  }
  return viewportCenteredOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, pane, zoom);
}

/**
 * Viewport for a focus: the focused node at the center, zoomed out just enough
 * to show its neighbors, but never below `minZoom` (far neighbors may then be
 * partly off screen; the focused node always stays close up).
 *
 * @param focusBox - Box of the focused node.
 * @param boxes - Boxes of the neighbors to show.
 * @param pane - Pane size.
 * @param minZoom - Lowest zoom.
 * @param maxZoom - Highest zoom.
 * @returns The viewport.
 */
export function viewportForFocus(
  focusBox: Box,
  boxes: readonly Box[],
  pane: PaneSize,
  minZoom: number,
  maxZoom: number,
): ViewportState {
  const bounds = unionBoxes([focusBox, ...boxes]) ?? focusBox;
  const centerX = focusBox.x + focusBox.width / 2;
  const centerY = focusBox.y + focusBox.height / 2;
  const halfWidth = Math.max(centerX - bounds.x, bounds.x + bounds.width - centerX, 1);
  const halfHeight = Math.max(centerY - bounds.y, bounds.y + bounds.height - centerY, 1);
  const zoom = Math.min(
    maxZoom,
    Math.max(
      minZoom,
      Math.min(
        (pane.width / 2 - VIEW_MARGIN) / halfWidth,
        (pane.height / 2 - VIEW_MARGIN) / halfHeight,
      ),
    ),
  );
  return viewportCenteredOn(centerX, centerY, pane, zoom);
}
