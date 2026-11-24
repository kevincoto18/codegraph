/**
 * Automatic layout of file and folder containers with the linear-time layered
 * layout, level by level, plus column wrapping for ranks that would otherwise
 * grow too tall.
 */

import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowEdge, CodeGraphFlowNode, FlowElements } from './flowTypes';
import type { FolderTree } from './folders';
import { layoutLayered } from './layeredLayout';
import {
  FILE_NODE_WIDTH,
  FOLDER_HEADER_HEIGHT,
  FOLDER_PADDING,
  toFlowElements,
} from './toFlowElements';

/** Tunable layout parameters. */
export interface LayoutOptions {
  /** Direction of dependencies: left-to-right or top-to-bottom. */
  readonly rankDirection: 'LR' | 'TB';
  /** Gap between files in the same rank, in pixels. */
  readonly nodeSeparation: number;
  /** Gap between ranks, in pixels. */
  readonly rankSeparation: number;
  /**
   * Maximum height of a rank column (LR only). Taller columns are split into
   * side-by-side sub-columns. `Infinity` disables wrapping.
   */
  readonly maxColumnHeight: number;
  /** Barycenter sweeps used to reduce edge crossings. */
  readonly sweeps: number;
}

/** Default layout: dependencies flow left to right, columns wrap at 2400 px. */
export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  rankDirection: 'LR',
  nodeSeparation: 40,
  rankSeparation: 140,
  maxColumnHeight: 2400,
  sweeps: 4,
};

/** Horizontal gap between sub-columns of a wrapped rank, in pixels. */
const SUB_COLUMN_GAP = 60;

/** Options of {@link buildFlowGraph}. */
export interface BuildFlowGraphOptions {
  /** Ids of the collapsed files and folders. */
  readonly collapsedIds?: ReadonlySet<string>;
  /** Folder hierarchy, or `null`/omitted to show every file at the top level. */
  readonly folderTree?: FolderTree | null;
  /** Layout parameters. */
  readonly layout?: LayoutOptions;
  /** Color of each folder (see `toFlowElements`). */
  readonly folderColors?: ReadonlyMap<string, string> | undefined;
}

/** Container id used for nodes at the top level of the canvas. */
const ROOT_CONTAINER = '';

/** A node placed by the layout (file or folder container) with its size. */
interface LayoutBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Positions file and folder containers with the layered layout, level by
 * level: the content of each expanded folder is laid out first (deepest
 * folders first), the folder is sized to fit it, and then the folder is laid
 * out among its siblings. At each level every edge is projected to the two
 * siblings that contain its endpoints, so dependencies between folders shape
 * the folder layout. Function nodes keep their positions relative to their file.
 *
 * @param elements - Unpositioned nodes and edges.
 * @param options - Layout parameters.
 * @returns A new node array with positioned (and, for folders, sized) containers.
 */
export function layoutFileNodes(
  elements: FlowElements,
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): CodeGraphFlowNode[] {
  return positionContainers(elements, options, null);
}

/**
 * Positions nodes after an incremental update without moving existing
 * containers: files and folders that were already laid out in the same parent
 * keep their position (including manual drags), and new ones are stacked in a
 * column to the right of their siblings. Folders are resized to fit their
 * content. A level where nothing survives is laid out from scratch.
 *
 * @param elements - Unpositioned nodes and edges of the updated graph.
 * @param previousNodes - Nodes currently displayed.
 * @param options - Layout parameters (gaps reused for the new column).
 * @returns A new node array.
 */
export function preserveFilePositions(
  elements: FlowElements,
  previousNodes: readonly CodeGraphFlowNode[],
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): CodeGraphFlowNode[] {
  return positionContainers(elements, options, previousNodes);
}

/**
 * Shared implementation of {@link layoutFileNodes} and {@link preserveFilePositions}.
 *
 * @param elements - Unpositioned nodes and edges.
 * @param options - Layout parameters.
 * @param previousNodes - Nodes currently displayed, or `null` for a full layout.
 * @returns A new node array.
 */
function positionContainers(
  elements: FlowElements,
  options: LayoutOptions,
  previousNodes: readonly CodeGraphFlowNode[] | null,
): CodeGraphFlowNode[] {
  const nodesById = new Map(elements.nodes.map((node) => [node.id, node]));
  /**
   * Returns the container of a file or folder.
   *
   * @param id - Node id.
   * @returns The parent folder id, or the root container.
   */
  const containerOf = (id: string): string => nodesById.get(id)?.parentId ?? ROOT_CONTAINER;

  const childrenByContainer = new Map<string, CodeGraphFlowNode[]>();
  const unitByNodeId = new Map<string, string>();
  for (const node of elements.nodes) {
    if (node.type === 'function') {
      unitByNodeId.set(node.id, node.parentId ?? node.id);
      continue;
    }
    unitByNodeId.set(node.id, node.id);
    const container = node.parentId ?? ROOT_CONTAINER;
    const siblings = childrenByContainer.get(container);
    if (siblings === undefined) {
      childrenByContainer.set(container, [node]);
    } else {
      siblings.push(node);
    }
  }

  const pairsByContainer = projectEdgesToLevels(elements.edges, unitByNodeId, containerOf);
  const previousById =
    previousNodes === null ? null : new Map(previousNodes.map((node) => [node.id, node]));
  const sizes = new Map<string, { width: number; height: number }>();
  const positions = new Map<string, { x: number; y: number }>();

  /**
   * Counts the containers above a node.
   *
   * @param id - Node or container id.
   * @returns 0 for the root container, 1 for top-level nodes, and so on.
   */
  const depthOf = (id: string): number => {
    let depth = 0;
    for (let current = id; current !== ROOT_CONTAINER; current = containerOf(current)) {
      depth += 1;
    }
    return depth;
  };
  // Deepest containers first, so every folder is sized before its parent level.
  const containers = [...childrenByContainer.keys()].sort((a, b) => depthOf(b) - depthOf(a));

  for (const container of containers) {
    const boxes = (childrenByContainer.get(container) ?? []).map((node) => ({
      id: node.id,
      width: sizes.get(node.id)?.width ?? node.width ?? 0,
      height: sizes.get(node.id)?.height ?? node.height ?? 0,
    }));
    const kept =
      previousById === null ? null : keepPreviousPositions(boxes, container, previousById, options);
    const placed = kept ?? layoutLevel(boxes, pairsByContainer.get(container) ?? [], options);

    if (container === ROOT_CONTAINER) {
      for (const box of placed) {
        positions.set(box.id, { x: box.x, y: box.y });
      }
      continue;
    }
    // Inside a folder: keep children clear of the header and size the folder
    // around them. A fresh layout is normalized; kept positions only move if
    // something would overlap the header.
    const isFresh = kept === null;
    const minX = Math.min(...placed.map((box) => box.x));
    const minY = Math.min(...placed.map((box) => box.y));
    const offsetX = isFresh ? FOLDER_PADDING - minX : Math.max(0, FOLDER_PADDING - minX);
    const offsetY = isFresh
      ? FOLDER_HEADER_HEIGHT + FOLDER_PADDING - minY
      : Math.max(0, FOLDER_HEADER_HEIGHT + FOLDER_PADDING - minY);
    let right = 0;
    let bottom = 0;
    for (const box of placed) {
      const position = { x: box.x + offsetX, y: box.y + offsetY };
      positions.set(box.id, position);
      right = Math.max(right, position.x + box.width);
      bottom = Math.max(bottom, position.y + box.height);
    }
    sizes.set(container, {
      width: Math.max(right + FOLDER_PADDING, FILE_NODE_WIDTH),
      height: bottom + FOLDER_PADDING,
    });
  }

  return elements.nodes.map((node) => {
    const position = positions.get(node.id);
    const size = sizes.get(node.id);
    if (position === undefined && size === undefined) {
      return node;
    }
    return {
      ...node,
      ...(position === undefined ? {} : { position }),
      ...(size === undefined ? {} : { width: size.width, height: size.height }),
    };
  });
}

/**
 * Lays out the children of one container with the layered layout, wrapping
 * tall columns in left-to-right layouts.
 *
 * @param boxes - Children with their sizes.
 * @param pairs - Dependencies between the children.
 * @param options - Layout parameters.
 * @returns The children with their positions.
 */
function layoutLevel(
  boxes: readonly { id: string; width: number; height: number }[],
  pairs: readonly (readonly [string, string])[],
  options: LayoutOptions,
): LayoutBox[] {
  const positions = layoutLayered(boxes, pairs, {
    direction: options.rankDirection,
    nodeSeparation: options.nodeSeparation,
    rankSeparation: options.rankSeparation,
    sweeps: options.sweeps,
  });
  const placed = boxes.map((box) => ({ ...box, ...(positions.get(box.id) ?? { x: 0, y: 0 }) }));
  if (options.rankDirection !== 'LR') {
    return placed;
  }
  const wrapped = wrapBoxes(placed, options.maxColumnHeight, options.nodeSeparation);
  return placed.map((box) => ({ ...box, ...(wrapped.get(box.id) ?? {}) }));
}

/**
 * Keeps the previous positions of the children that were already displayed
 * in the same container, stacking new children in a column to their right.
 *
 * @param boxes - Children with their current sizes.
 * @param container - Id of the container.
 * @param previousById - Nodes currently displayed, by id.
 * @param options - Layout parameters (gaps of the new column).
 * @returns The placed children, or `null` if none was displayed before.
 */
function keepPreviousPositions(
  boxes: readonly { id: string; width: number; height: number }[],
  container: string,
  previousById: ReadonlyMap<string, CodeGraphFlowNode>,
  options: LayoutOptions,
): LayoutBox[] | null {
  const kept = boxes.flatMap((box) => {
    const previous = previousById.get(box.id);
    return previous !== undefined && (previous.parentId ?? ROOT_CONTAINER) === container
      ? [{ ...box, ...previous.position }]
      : [];
  });
  if (kept.length === 0) {
    return null;
  }
  const keptById = new Map(kept.map((box) => [box.id, box]));
  const newColumnX =
    Math.max(...kept.map((box) => box.x + (previousById.get(box.id)?.width ?? box.width))) +
    options.rankSeparation;
  let nextY = Math.min(...kept.map((box) => box.y));
  return boxes.map((box) => {
    const keptBox = keptById.get(box.id);
    if (keptBox !== undefined) {
      return keptBox;
    }
    const placed = { ...box, x: newColumnX, y: nextY };
    nextY += box.height + options.nodeSeparation;
    return placed;
  });
}

/**
 * Projects edges to every level of the hierarchy: an edge between two nodes
 * becomes a dependency between the two siblings that contain them inside
 * their lowest common container.
 *
 * @param edges - Canvas edges.
 * @param unitByNodeId - File or folder of every node (functions map to their file).
 * @param containerOf - Container of a file or folder.
 * @returns Unique `[source, target]` sibling pairs, by container.
 */
export function projectEdgesToLevels(
  edges: readonly CodeGraphFlowEdge[],
  unitByNodeId: ReadonlyMap<string, string>,
  containerOf: (id: string) => string,
): Map<string, [string, string][]> {
  const pairs = new Map<string, Map<string, [string, string]>>();
  for (const edge of edges) {
    const source = unitByNodeId.get(edge.source);
    const target = unitByNodeId.get(edge.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    // Child on the source's path, by container.
    const sourcePath = new Map<string, string>();
    for (let child = source; ; child = containerOf(child)) {
      const container = containerOf(child);
      sourcePath.set(container, child);
      if (container === ROOT_CONTAINER) {
        break;
      }
    }
    for (let child = target; ; child = containerOf(child)) {
      const container = containerOf(child);
      const sourceChild = sourcePath.get(container);
      if (sourceChild !== undefined) {
        if (sourceChild !== child) {
          const level = pairs.get(container) ?? new Map<string, [string, string]>();
          level.set(`${sourceChild}\u0000${child}`, [sourceChild, child]);
          pairs.set(container, level);
        }
        break;
      }
      if (container === ROOT_CONTAINER) {
        break;
      }
    }
  }
  return new Map([...pairs].map(([container, level]) => [container, [...level.values()]]));
}

/**
 * Maps edges to distinct `[sourceFile, targetFile]` pairs, dropping edges
 * inside a single file.
 *
 * @param edges - Canvas edges.
 * @param fileIdByNodeId - File id of every node (files map to themselves).
 * @returns Unique file-level pairs.
 */
export function projectEdgesToFiles(
  edges: readonly CodeGraphFlowEdge[],
  fileIdByNodeId: ReadonlyMap<string, string>,
): [string, string][] {
  const pairs = new Map<string, [string, string]>();
  for (const edge of edges) {
    const source = fileIdByNodeId.get(edge.source);
    const target = fileIdByNodeId.get(edge.target);
    if (source !== undefined && target !== undefined && source !== target) {
      pairs.set(`${source}\u0000${target}`, [source, target]);
    }
  }
  return [...pairs.values()];
}

/**
 * Splits a list of stacked heights into consecutive groups whose stacked
 * height (including gaps) does not exceed a maximum. Every group has at
 * least one item, even if that item alone exceeds the maximum.
 *
 * @param heights - Item heights, in stacking order.
 * @param maxHeight - Maximum stacked height of a group.
 * @param gap - Vertical gap between stacked items.
 * @returns Groups of item indexes.
 */
export function chunkByHeight(
  heights: readonly number[],
  maxHeight: number,
  gap: number,
): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let currentHeight = 0;
  heights.forEach((height, index) => {
    const nextHeight = current.length === 0 ? height : currentHeight + gap + height;
    if (current.length > 0 && nextHeight > maxHeight) {
      chunks.push(current);
      current = [index];
      currentHeight = height;
      return;
    }
    current.push(index);
    currentHeight = nextHeight;
  });
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Computes the height of items stacked vertically with a gap between them.
 *
 * @param heights - Item heights.
 * @param gap - Vertical gap between items.
 * @returns Total stacked height (0 for no items).
 */
export function stackedHeight(heights: readonly number[], gap: number): number {
  return heights.length === 0
    ? 0
    : heights.reduce((sum, height) => sum + height, 0) + gap * (heights.length - 1);
}

/**
 * Splits rank columns taller than `maxColumnHeight` into side-by-side
 * sub-columns, shifting the columns to their right to make room. The wrapped
 * block is centered on the original column center.
 *
 * @remarks Assumes a left-to-right layout where every box of a rank shares
 * the same `x` (true for the layered layout, which aligns each rank).
 *
 * @param boxes - Boxes positioned by the layered layout.
 * @param maxColumnHeight - Maximum stacked height of a column.
 * @param rowGap - Vertical gap between restacked boxes.
 * @returns New positions of the boxes, by id.
 */
export function wrapBoxes(
  boxes: readonly LayoutBox[],
  maxColumnHeight: number,
  rowGap: number,
): Map<string, { x: number; y: number }> {
  const columns = new Map<number, LayoutBox[]>();
  for (const box of boxes) {
    const key = Math.round(box.x);
    const column = columns.get(key);
    if (column === undefined) {
      columns.set(key, [box]);
    } else {
      column.push(box);
    }
  }

  const newPositions = new Map<string, { x: number; y: number }>();
  let shift = 0;
  for (const [x, column] of [...columns.entries()].sort(([a], [b]) => a - b)) {
    const stacked = [...column].sort((a, b) => a.y - b.y);
    const chunks = chunkByHeight(
      stacked.map((box) => box.height),
      maxColumnHeight,
      rowGap,
    );
    const columnWidth = Math.max(...stacked.map((box) => box.width));

    if (chunks.length === 1) {
      for (const box of stacked) {
        newPositions.set(box.id, { x: x + shift, y: box.y });
      }
      continue;
    }

    // Center the wrapped block on the original column center, so it stays
    // aligned with the neighbouring (unsplit) columns, which are centered too.
    const originalTop = Math.min(...stacked.map((box) => box.y));
    const originalBottom = Math.max(...stacked.map((box) => box.y + box.height));
    const blockHeight = Math.max(
      ...chunks.map((chunk) =>
        stackedHeight(
          chunk.map((index) => stacked[index]?.height ?? 0),
          rowGap,
        ),
      ),
    );
    const top = (originalTop + originalBottom) / 2 - blockHeight / 2;
    chunks.forEach((chunk, chunkIndex) => {
      let y = top;
      for (const index of chunk) {
        const box = stacked[index];
        if (box === undefined) {
          continue;
        }
        newPositions.set(box.id, {
          x: x + shift + chunkIndex * (columnWidth + SUB_COLUMN_GAP),
          y,
        });
        y += box.height + rowGap;
      }
    });
    shift += (chunks.length - 1) * (columnWidth + SUB_COLUMN_GAP);
  }
  return newPositions;
}

/**
 * Applies {@link wrapBoxes} to the top-level file and folder containers of a node list.
 *
 * @param nodes - Nodes positioned by the layered layout.
 * @param maxColumnHeight - Maximum stacked height of a column.
 * @param rowGap - Vertical gap between restacked containers.
 * @returns A new node array with wrapped positions.
 */
export function wrapTallColumns(
  nodes: readonly CodeGraphFlowNode[],
  maxColumnHeight: number,
  rowGap: number,
): CodeGraphFlowNode[] {
  const boxes = nodes
    .filter((node) => node.type !== 'function' && node.parentId === undefined)
    .map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? 0,
      height: node.height ?? 0,
    }));
  const newPositions = wrapBoxes(boxes, maxColumnHeight, rowGap);
  return nodes.map((node) => {
    const position = newPositions.get(node.id);
    return position === undefined ? node : { ...node, position };
  });
}

/**
 * Converts a snapshot into positioned React Flow elements.
 *
 * @param snapshot - Graph snapshot.
 * @param options - Collapsed containers, folder hierarchy and layout parameters.
 * @returns Positioned nodes and edges.
 */
export function buildFlowGraph(
  snapshot: GraphSnapshot,
  options: BuildFlowGraphOptions = {},
): FlowElements {
  const elements = toFlowElements(
    snapshot,
    options.collapsedIds,
    options.folderTree ?? null,
    options.folderColors,
  );
  return {
    nodes: layoutFileNodes(elements, options.layout ?? DEFAULT_LAYOUT_OPTIONS),
    edges: elements.edges,
  };
}
