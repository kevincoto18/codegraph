/**
 * Captures the canvas as a PNG or SVG image (with `html-to-image`), either
 * the visible area or a box around some nodes at full detail.
 *
 * @remarks `html-to-image` is pinned to 1.11.11: later versions drop the
 * styles of SVG paths, so edges vanish from the image.
 */
import { toPng, toSvg } from 'html-to-image';

/** Margin around the captured nodes, in pixels. */
const CAPTURE_PADDING = 32;

/** Largest side of a captured image, in pixels (bigger graphs are scaled down). */
const MAX_IMAGE_SIDE = 8000;

/** Canvas parts that are not part of the diagram. */
const CHROME_CLASSES = [
  'react-flow__panel',
  'react-flow__controls',
  'react-flow__minimap',
  'react-flow__attribution',
];

/** Box of the nodes to capture, in canvas coordinates. */
export interface CaptureBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Reads the id of a canvas element (node or edge), if any.
 *
 * @param element - DOM element.
 * @returns Its React Flow id, or `null`.
 */
function flowIdOf(element: Element): string | null {
  const dataId = element.getAttribute('data-id');
  if (dataId !== null) {
    return dataId;
  }
  const testId = element.getAttribute('data-testid');
  return testId?.replace(/^rf__(node|edge)-/, '') ?? null;
}

/**
 * Builds the filter that leaves out the canvas chrome and, when given, the
 * nodes and edges outside a selection.
 *
 * @param keepNodes - Node ids to keep, or `null` for all.
 * @param keepEdges - Edge ids to keep, or `null` for all.
 * @returns The `html-to-image` filter.
 */
function captureFilter(
  keepNodes: ReadonlySet<string> | null,
  keepEdges: ReadonlySet<string> | null,
): (node: HTMLElement) => boolean {
  return (node) => {
    const classes = node.classList as DOMTokenList | undefined;
    if (classes === undefined) {
      return true;
    }
    if (CHROME_CLASSES.some((name) => classes.contains(name))) {
      return false;
    }
    if (keepNodes !== null && classes.contains('react-flow__node')) {
      return keepNodes.has(flowIdOf(node) ?? '');
    }
    if (keepEdges !== null && classes.contains('react-flow__edge')) {
      return keepEdges.has(flowIdOf(node) ?? '');
    }
    return true;
  };
}

/**
 * Background color of the view, so images are not transparent.
 *
 * @returns A CSS color.
 */
function backgroundColor(): string {
  return getComputedStyle(document.body).backgroundColor || '#1e1e1e';
}

/**
 * Captures the visible area of the canvas.
 *
 * @param flow - The `.react-flow` element.
 * @param format - Image format.
 * @returns The image as a `data:` URL.
 */
export function captureVisibleArea(flow: HTMLElement, format: 'png' | 'svg'): Promise<string> {
  const capture = format === 'png' ? toPng : toSvg;
  return capture(flow, {
    backgroundColor: backgroundColor(),
    filter: captureFilter(null, null),
    pixelRatio: format === 'png' ? 2 : 1,
  });
}

/**
 * Captures a box of the canvas at zoom 1 (full detail), keeping only some
 * nodes and edges when asked. The viewport must be at zoom 1 and every node
 * of the box rendered.
 *
 * @param viewport - The `.react-flow__viewport` element.
 * @param box - Box to capture, in canvas coordinates.
 * @param format - Image format.
 * @param keepNodes - Node ids to keep, or `null` for all.
 * @param keepEdges - Edge ids to keep, or `null` for all.
 * @returns The image as a `data:` URL.
 */
export function captureBox(
  viewport: HTMLElement,
  box: CaptureBox,
  format: 'png' | 'svg',
  keepNodes: ReadonlySet<string> | null,
  keepEdges: ReadonlySet<string> | null,
): Promise<string> {
  const width = box.width + 2 * CAPTURE_PADDING;
  const height = box.height + 2 * CAPTURE_PADDING;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  const capture = format === 'png' ? toPng : toSvg;
  return capture(viewport, {
    backgroundColor: backgroundColor(),
    width: Math.ceil(width * scale),
    height: Math.ceil(height * scale),
    filter: captureFilter(keepNodes, keepEdges),
    style: {
      width: `${String(Math.ceil(width * scale))}px`,
      height: `${String(Math.ceil(height * scale))}px`,
      transform: `translate(${String((CAPTURE_PADDING - box.x) * scale)}px, ${String((CAPTURE_PADDING - box.y) * scale)}px) scale(${String(scale)})`,
    },
  });
}
