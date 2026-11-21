/**
 * Automatic layout of file containers with the linear-time layered layout,
 * plus column wrapping for ranks that would otherwise grow too tall.
 */

import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowEdge, CodeGraphFlowNode, FlowElements } from './flowTypes';
import { layoutLayered } from './layeredLayout';
import { toFlowElements } from './toFlowElements';

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
  /** Ids of the files whose functions are hidden. */
  readonly collapsedFileIds?: ReadonlySet<string>;
  /** Layout parameters. */
  readonly layout?: LayoutOptions;
}

/**
 * Positions file containers with the layered layout. Every edge is projected
 * to the file level, so files that call each other are ranked like files that
 * import each other. Function nodes keep their positions relative to their file.
 *
 * @param elements - Unpositioned nodes and edges.
 * @param options - Layout parameters.
 * @returns A new node array with positioned file containers.
 */
export function layoutFileNodes(
  elements: FlowElements,
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): CodeGraphFlowNode[] {
  const fileIdByNodeId = new Map<string, string>();
  const files: { id: string; width: number; height: number }[] = [];
  for (const node of elements.nodes) {
    fileIdByNodeId.set(node.id, node.parentId ?? node.id);
    if (node.type === 'file') {
      files.push({ id: node.id, width: node.width ?? 0, height: node.height ?? 0 });
    }
  }

  const positions = layoutLayered(files, projectEdgesToFiles(elements.edges, fileIdByNodeId), {
    direction: options.rankDirection,
    nodeSeparation: options.nodeSeparation,
    rankSeparation: options.rankSeparation,
    sweeps: options.sweeps,
  });

  const positioned = elements.nodes.map((node) => {
    const position = node.type === 'file' ? positions.get(node.id) : undefined;
    return position === undefined ? node : { ...node, position };
  });

  return options.rankDirection === 'LR'
    ? wrapTallColumns(positioned, options.maxColumnHeight, options.nodeSeparation)
    : positioned;
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
 * @remarks Assumes a left-to-right layout where every file in a rank shares
 * the same `x` (true for the layered layout, since all file containers have equal width).
 *
 * @param nodes - Nodes positioned by the layered layout.
 * @param maxColumnHeight - Maximum stacked height of a column.
 * @param rowGap - Vertical gap between restacked files.
 * @returns A new node array with wrapped file positions.
 */
export function wrapTallColumns(
  nodes: readonly CodeGraphFlowNode[],
  maxColumnHeight: number,
  rowGap: number,
): CodeGraphFlowNode[] {
  const columns = new Map<number, CodeGraphFlowNode[]>();
  for (const node of nodes) {
    if (node.type === 'file') {
      const key = Math.round(node.position.x);
      columns.set(key, [...(columns.get(key) ?? []), node]);
    }
  }

  const newPositions = new Map<string, { x: number; y: number }>();
  let shift = 0;
  for (const [x, column] of [...columns.entries()].sort(([a], [b]) => a - b)) {
    const stacked = [...column].sort((a, b) => a.position.y - b.position.y);
    const chunks = chunkByHeight(
      stacked.map((node) => node.height ?? 0),
      maxColumnHeight,
      rowGap,
    );

    if (chunks.length === 1) {
      for (const node of stacked) {
        newPositions.set(node.id, { x: x + shift, y: node.position.y });
      }
      continue;
    }

    // Center the wrapped block on the original column center, so it stays
    // aligned with the neighbouring (unsplit) columns, which are centered too.
    const originalTop = Math.min(...stacked.map((node) => node.position.y));
    const originalBottom = Math.max(...stacked.map((node) => node.position.y + (node.height ?? 0)));
    const blockHeight = Math.max(
      ...chunks.map((chunk) =>
        stackedHeight(
          chunk.map((index) => stacked[index]?.height ?? 0),
          rowGap,
        ),
      ),
    );
    const top = (originalTop + originalBottom) / 2 - blockHeight / 2;
    const columnWidth = Math.max(...stacked.map((node) => node.width ?? 0));
    chunks.forEach((chunk, chunkIndex) => {
      let y = top;
      for (const index of chunk) {
        const node = stacked[index];
        if (node === undefined) {
          continue;
        }
        newPositions.set(node.id, {
          x: x + shift + chunkIndex * (columnWidth + SUB_COLUMN_GAP),
          y,
        });
        y += (node.height ?? 0) + rowGap;
      }
    });
    shift += (chunks.length - 1) * (columnWidth + SUB_COLUMN_GAP);
  }

  return nodes.map((node) => {
    const position = newPositions.get(node.id);
    return position === undefined ? node : { ...node, position };
  });
}

/**
 * Converts a snapshot into positioned React Flow elements.
 *
 * @param snapshot - Graph snapshot.
 * @param options - Collapsed files and layout parameters.
 * @returns Positioned nodes and edges.
 */
export function buildFlowGraph(
  snapshot: GraphSnapshot,
  options: BuildFlowGraphOptions = {},
): FlowElements {
  const elements = toFlowElements(snapshot, options.collapsedFileIds);
  return {
    nodes: layoutFileNodes(elements, options.layout ?? DEFAULT_LAYOUT_OPTIONS),
    edges: elements.edges,
  };
}

/**
 * Positions nodes after an incremental update without moving existing files:
 * files that were already laid out keep their position (including manual
 * drags), and new files are stacked in a column to the right of the graph.
 * Falls back to a full layout when no previous file survives.
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
  const previousFiles = new Map(
    previousNodes.filter((node) => node.type === 'file').map((node) => [node.id, node]),
  );
  const keptFiles = elements.nodes.filter(
    (node) => node.type === 'file' && previousFiles.has(node.id),
  );
  if (keptFiles.length === 0) {
    return layoutFileNodes(elements, options);
  }

  let maxRight = -Infinity;
  let minTop = Infinity;
  for (const node of keptFiles) {
    const previous = previousFiles.get(node.id);
    if (previous !== undefined) {
      maxRight = Math.max(maxRight, previous.position.x + (previous.width ?? 0));
      minTop = Math.min(minTop, previous.position.y);
    }
  }

  const newColumnX = maxRight + options.rankSeparation;
  let nextY = minTop;
  const result: CodeGraphFlowNode[] = [];
  for (const node of elements.nodes) {
    if (node.type !== 'file') {
      result.push(node);
      continue;
    }
    const previous = previousFiles.get(node.id);
    if (previous !== undefined) {
      result.push({ ...node, position: previous.position });
      continue;
    }
    result.push({ ...node, position: { x: newColumnX, y: nextY } });
    nextY += (node.height ?? 0) + options.nodeSeparation;
  }
  return result;
}
