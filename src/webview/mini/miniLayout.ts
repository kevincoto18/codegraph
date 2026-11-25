/**
 * Geometry of the side mini graph: neighbors around a center card, laid out
 * left/right when the view is wide and above/below when it is narrow, always
 * centered in the available space.
 */

/** A positioned rectangle. */
export interface MiniBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A positioned section title ("Used by", "Uses"). */
export interface MiniLabel {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** A curved edge between a neighbor and the center. */
export interface MiniEdgePath {
  /** Neighbor id. */
  readonly id: string;
  readonly side: 'in' | 'out';
  /** Single connector between a whole section and the center (narrow layout). */
  readonly trunk: boolean;
  /** SVG path data (cubic Bézier). */
  readonly path: string;
}

/** Complete layout. */
export interface MiniLayout {
  readonly orientation: 'horizontal' | 'vertical';
  /** Size of the drawing (at least the viewport). */
  readonly width: number;
  readonly height: number;
  readonly center: MiniBox;
  readonly incoming: readonly MiniBox[];
  readonly outgoing: readonly MiniBox[];
  /** "+N more" rows, when some neighbors are left out. */
  readonly moreIncoming: MiniBox | null;
  readonly moreOutgoing: MiniBox | null;
  readonly incomingLabel: MiniLabel;
  readonly outgoingLabel: MiniLabel;
  readonly edges: readonly MiniEdgePath[];
}

/** What to lay out. */
export interface MiniLayoutInput {
  /** Neighbor ids on each side (an empty side gets one placeholder box). */
  readonly incoming: readonly string[];
  readonly outgoing: readonly string[];
  readonly hasMoreIncoming: boolean;
  readonly hasMoreOutgoing: boolean;
  /** Measured (or estimated) height of the center card. */
  readonly centerHeight: number;
}

/** Id of the placeholder box drawn on an empty side. */
export const EMPTY_INCOMING_ID = '__none-in';
export const EMPTY_OUTGOING_ID = '__none-out';

/** Narrowest view that still gets the left/right layout. */
export const HORIZONTAL_MIN_WIDTH = 600;

const PADDING = 16;
const NODE_HEIGHT = 42;
const NODE_GAP = 8;
const MORE_HEIGHT = 22;
const LABEL_HEIGHT = 22;
/** Room for the edges between a column and the center. */
const COLUMN_GAP = 40;
const SECTION_GAP = 34;
/** Most distance between two edges where they meet the center card. */
const ANCHOR_SPACING = 12;
/** Room left between a trunk connector and what it links. */
const TRUNK_INSET = 4;
/** Id of the connector of each section in the narrow layout. */
export const TRUNK_IN_ID = '__trunk-in';
export const TRUNK_OUT_ID = '__trunk-out';
/** Narrowest content width that gets two columns in the narrow layout. */
const TWO_COLUMNS_MIN_WIDTH = 360;

/**
 * Clamps a value to a range.
 *
 * @param value - Value.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns The clamped value.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Gathers `count` anchor points around the middle of a side of the center
 * card, so the edges converge on it.
 *
 * @param start - Side start.
 * @param length - Side length.
 * @param count - Number of anchors.
 * @param index - Anchor index.
 * @returns The anchor coordinate.
 */
function anchor(start: number, length: number, count: number, index: number): number {
  if (count <= 1) {
    return start + length / 2;
  }
  const spacing = Math.min(ANCHOR_SPACING, (length * 0.6) / (count - 1));
  return start + length / 2 + (index - (count - 1) / 2) * spacing;
}

/**
 * Height of a stack of boxes.
 *
 * @param rows - Number of rows.
 * @param hasMore - Whether a "+N more" row follows.
 * @returns The height, including the section title.
 */
function stackHeight(rows: number, hasMore: boolean): number {
  return (
    LABEL_HEIGHT +
    rows * NODE_HEIGHT +
    (rows - 1) * NODE_GAP +
    (hasMore ? NODE_GAP + MORE_HEIGHT : 0)
  );
}

/**
 * Horizontal Bézier between two points.
 *
 * @param x1 - Start x.
 * @param y1 - Start y.
 * @param x2 - End x.
 * @param y2 - End y.
 * @returns SVG path data.
 */
function horizontalCurve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) / 2;
  return `M ${String(x1)} ${String(y1)} C ${String(x1 + dx)} ${String(y1)}, ${String(x2 - dx)} ${String(y2)}, ${String(x2)} ${String(y2)}`;
}

/**
 * Vertical Bézier between two points.
 *
 * @param x1 - Start x.
 * @param y1 - Start y.
 * @param x2 - End x.
 * @param y2 - End y.
 * @returns SVG path data.
 */
function verticalCurve(x1: number, y1: number, x2: number, y2: number): string {
  const dy = (y2 - y1) / 2;
  return `M ${String(x1)} ${String(y1)} C ${String(x1)} ${String(y1 + dy)}, ${String(x2)} ${String(y2 - dy)}, ${String(x2)} ${String(y2)}`;
}

/**
 * Ids to draw on one side: the neighbors, or a placeholder when there are none.
 *
 * @param ids - Neighbor ids.
 * @param placeholder - Placeholder id.
 * @returns The ids to draw.
 */
function sideIds(ids: readonly string[], placeholder: string): readonly string[] {
  return ids.length === 0 ? [placeholder] : ids;
}

/**
 * Left/right layout: callers in a column on the left, dependencies on the right.
 *
 * @param input - What to lay out.
 * @param width - Viewport width.
 * @param height - Viewport height.
 * @returns The layout.
 */
function horizontalLayout(input: MiniLayoutInput, width: number, height: number): MiniLayout {
  const centerWidth = clamp(width * 0.36, 170, 280);
  const sideWidth = clamp((width - 2 * PADDING - 2 * COLUMN_GAP - centerWidth) / 2, 110, 210);
  const total = 2 * sideWidth + 2 * COLUMN_GAP + centerWidth;
  const left = Math.max(PADDING, (width - total) / 2);
  const centerX = left + sideWidth + COLUMN_GAP;
  const rightX = centerX + centerWidth + COLUMN_GAP;

  const inIds = sideIds(input.incoming, EMPTY_INCOMING_ID);
  const outIds = sideIds(input.outgoing, EMPTY_OUTGOING_ID);
  const inHeight = stackHeight(inIds.length, input.hasMoreIncoming);
  const outHeight = stackHeight(outIds.length, input.hasMoreOutgoing);
  const contentHeight = Math.max(input.centerHeight, inHeight, outHeight);
  const top = Math.max(PADDING, (height - contentHeight) / 2);
  const middle = top + contentHeight / 2;

  const center: MiniBox = {
    id: 'center',
    x: centerX,
    y: middle - input.centerHeight / 2,
    width: centerWidth,
    height: input.centerHeight,
  };

  /**
   * Places one column.
   *
   * @param ids - Ids in the column.
   * @param x - Column x.
   * @param columnHeight - Column height.
   * @param hasMore - Whether a "+N more" row follows.
   * @returns Boxes, "+N more" row and title of the column.
   */
  const column = (
    ids: readonly string[],
    x: number,
    columnHeight: number,
    hasMore: boolean,
  ): { boxes: MiniBox[]; more: MiniBox | null; label: MiniLabel } => {
    const start = middle - columnHeight / 2;
    const boxes = ids.map((id, index) => ({
      id,
      x,
      y: start + LABEL_HEIGHT + index * (NODE_HEIGHT + NODE_GAP),
      width: sideWidth,
      height: NODE_HEIGHT,
    }));
    const more = hasMore
      ? {
          id: 'more',
          x,
          y: start + LABEL_HEIGHT + ids.length * (NODE_HEIGHT + NODE_GAP),
          width: sideWidth,
          height: MORE_HEIGHT,
        }
      : null;
    return { boxes, more, label: { x, y: start, width: sideWidth } };
  };

  const incoming = column(inIds, left, inHeight, input.hasMoreIncoming);
  const outgoing = column(outIds, rightX, outHeight, input.hasMoreOutgoing);
  const edges: MiniEdgePath[] = [
    ...incoming.boxes.slice(0, input.incoming.length).map((box, index) => {
      return {
        id: box.id,
        side: 'in' as const,
        trunk: false,
        path: horizontalCurve(
          box.x + box.width,
          box.y + box.height / 2,
          center.x,
          anchor(center.y, center.height, input.incoming.length, index),
        ),
      };
    }),
    ...outgoing.boxes.slice(0, input.outgoing.length).map((box, index) => {
      return {
        id: box.id,
        side: 'out' as const,
        trunk: false,
        path: horizontalCurve(
          center.x + center.width,
          anchor(center.y, center.height, input.outgoing.length, index),
          box.x,
          box.y + box.height / 2,
        ),
      };
    }),
  ];
  return {
    orientation: 'horizontal',
    width: Math.max(width, left + total + PADDING),
    height: Math.max(height, top + contentHeight + PADDING),
    center,
    incoming: incoming.boxes,
    outgoing: outgoing.boxes,
    moreIncoming: incoming.more,
    moreOutgoing: outgoing.more,
    incomingLabel: incoming.label,
    outgoingLabel: outgoing.label,
    edges,
  };
}

/**
 * Top/bottom layout for narrow views: callers above the center, dependencies
 * below, each in a grid of one or two columns, linked to the center by a
 * single connector per section.
 *
 * @param input - What to lay out.
 * @param width - Viewport width.
 * @param height - Viewport height.
 * @returns The layout.
 */
function verticalLayout(input: MiniLayoutInput, width: number, height: number): MiniLayout {
  const innerWidth = Math.max(160, Math.min(width - 2 * PADDING, 420));
  const left = Math.max(PADDING, (width - innerWidth) / 2);
  const columns = innerWidth >= TWO_COLUMNS_MIN_WIDTH ? 2 : 1;
  const nodeWidth = (innerWidth - (columns - 1) * NODE_GAP) / columns;
  const centerWidth = Math.min(innerWidth, 300);

  const inIds = sideIds(input.incoming, EMPTY_INCOMING_ID);
  const outIds = sideIds(input.outgoing, EMPTY_OUTGOING_ID);
  const inRows = Math.ceil(inIds.length / columns);
  const outRows = Math.ceil(outIds.length / columns);
  const inHeight = stackHeight(inRows, input.hasMoreIncoming);
  const outHeight = stackHeight(outRows, input.hasMoreOutgoing);
  const contentHeight = inHeight + SECTION_GAP + input.centerHeight + SECTION_GAP + outHeight;
  const top = Math.max(PADDING, (height - contentHeight) / 2);

  /**
   * Places one grid; a partial last row is centered.
   *
   * @param ids - Ids in the grid.
   * @param y - Grid top (title included).
   * @param hasMore - Whether a "+N more" row follows.
   * @returns Boxes, "+N more" row and title of the grid.
   */
  const grid = (
    ids: readonly string[],
    y: number,
    hasMore: boolean,
  ): { boxes: MiniBox[]; more: MiniBox | null; label: MiniLabel } => {
    const rows = Math.ceil(ids.length / columns);
    const boxes = ids.map((id, index) => {
      const row = Math.floor(index / columns);
      const inRow = row === rows - 1 ? ids.length - row * columns : columns;
      const rowWidth = inRow * nodeWidth + (inRow - 1) * NODE_GAP;
      const rowLeft = left + (innerWidth - rowWidth) / 2;
      return {
        id,
        x: rowLeft + (index % columns) * (nodeWidth + NODE_GAP),
        y: y + LABEL_HEIGHT + row * (NODE_HEIGHT + NODE_GAP),
        width: nodeWidth,
        height: NODE_HEIGHT,
      };
    });
    const more = hasMore
      ? {
          id: 'more',
          x: left,
          y: y + LABEL_HEIGHT + rows * (NODE_HEIGHT + NODE_GAP),
          width: innerWidth,
          height: MORE_HEIGHT,
        }
      : null;
    return { boxes, more, label: { x: left, y, width: innerWidth } };
  };

  const incoming = grid(inIds, top, input.hasMoreIncoming);
  const center: MiniBox = {
    id: 'center',
    x: left + (innerWidth - centerWidth) / 2,
    y: top + inHeight + SECTION_GAP,
    width: centerWidth,
    height: input.centerHeight,
  };
  const outgoing = grid(outIds, center.y + center.height + SECTION_GAP, input.hasMoreOutgoing);
  // One connector per section: per-node edges would cross the stacked cards.
  const middle = center.x + center.width / 2;
  const edges: MiniEdgePath[] = [];
  if (input.incoming.length > 0) {
    edges.push({
      id: TRUNK_IN_ID,
      side: 'in',
      trunk: true,
      path: verticalCurve(middle, top + inHeight + TRUNK_INSET, middle, center.y),
    });
  }
  if (input.outgoing.length > 0) {
    edges.push({
      id: TRUNK_OUT_ID,
      side: 'out',
      trunk: true,
      path: verticalCurve(middle, center.y + center.height, middle, outgoing.label.y - TRUNK_INSET),
    });
  }
  return {
    orientation: 'vertical',
    width: Math.max(width, left + innerWidth + PADDING),
    height: Math.max(height, top + contentHeight + PADDING),
    center,
    incoming: incoming.boxes,
    outgoing: outgoing.boxes,
    moreIncoming: incoming.more,
    moreOutgoing: outgoing.more,
    incomingLabel: incoming.label,
    outgoingLabel: outgoing.label,
    edges,
  };
}

/**
 * Lays out the mini graph in a viewport.
 *
 * @param input - Neighbors and center height.
 * @param width - Viewport width.
 * @param height - Viewport height.
 * @returns The layout, centered in the viewport (scrollable when larger).
 */
export function layoutMiniGraph(input: MiniLayoutInput, width: number, height: number): MiniLayout {
  return width >= HORIZONTAL_MIN_WIDTH
    ? horizontalLayout(input, width, height)
    : verticalLayout(input, width, height);
}
