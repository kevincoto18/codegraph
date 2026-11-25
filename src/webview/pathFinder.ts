/**
 * Shortest path between two nodes of the graph ("How does A reach B?").
 * Pure, so it is unit-tested.
 */
import type { GraphSnapshot } from '../shared';

/** Shortest path found between two nodes. */
export interface GraphPath {
  /** Node ids from the start to the end, both included. */
  readonly nodeIds: readonly string[];
  /** Ids of the model edges followed, one per step. */
  readonly edgeIds: readonly string[];
  /** Whether the path goes from the second node to the first one (none the asked way). */
  readonly reversed: boolean;
  /**
   * `function`: calls between functions. `file`: imports and calls between
   * files (when an end is a file).
   */
  readonly level: 'function' | 'file';
}

/** One outgoing step of the search graph. */
interface Step {
  readonly to: string;
  readonly edgeId: string;
}

/**
 * Builds the adjacency of the search graph: calls between functions, or
 * imports and calls lifted to their files.f
 *
 * @param snapshot - Graph.
 * @param level - Level of the search.
 * @returns Outgoing steps of each node.
 */
function buildAdjacency(snapshot: GraphSnapshot, level: GraphPath['level']): Map<string, Step[]> {
  const fileOf = new Map<string, string>();
  for (const node of snapshot.nodes) {
    fileOf.set(node.id, node.kind === 'function' ? node.fileId : node.id);
  }
  const adjacency = new Map<string, Step[]>();
  const seen = new Set<string>();
  /**
   * Adds a step once per pair of nodes (imports are preferred: they come first).
   *
   * @param from - Origin.
   * @param to - Destination.
   * @param edgeId - Model edge followed.
   */
  const add = (from: string, to: string, edgeId: string): void => {
    const key = `${from}\u0000${to}`;
    if (from === to || seen.has(key)) {
      return;
    }
    seen.add(key);
    const steps = adjacency.get(from) ?? [];
    steps.push({ to, edgeId });
    adjacency.set(from, steps);
  };
  const edges =
    level === 'file'
      ? [...snapshot.edges].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'import' ? -1 : 1))
      : snapshot.edges;
  for (const edge of edges) {
    if (level === 'function') {
      if (edge.kind === 'call') {
        add(edge.source, edge.target, edge.id);
      }
      continue;
    }
    const from = fileOf.get(edge.source);
    const to = fileOf.get(edge.target);
    if (from !== undefined && to !== undefined) {
      add(from, to, edge.id);
    }
  }
  return adjacency;
}

/** How the search reached a node: from which node, through which edge. */
type Link = { readonly node: string; readonly edgeId: string } | null;

/**
 * Rebuilds the path that the search followed to a node.
 *
 * @param previous - How each reached node was reached.
 * @param to - End node.
 * @returns Nodes and edges from the start to the end.
 */
function rebuild(
  previous: ReadonlyMap<string, Link>,
  to: string,
): { nodeIds: string[]; edgeIds: string[] } {
  const nodeIds = [to];
  const edgeIds: string[] = [];
  for (let link = previous.get(to); link !== undefined && link !== null;) {
    edgeIds.push(link.edgeId);
    nodeIds.push(link.node);
    link = previous.get(link.node);
  }
  return { nodeIds: nodeIds.reverse(), edgeIds: edgeIds.reverse() };
}

/**
 * Breadth-first search from one node to another.
 *
 * @param adjacency - Search graph.
 * @param from - Start node.
 * @param to - End node.
 * @returns Nodes and edges of a shortest path, or `null`.
 */
function search(
  adjacency: ReadonlyMap<string, readonly Step[]>,
  from: string,
  to: string,
): { nodeIds: string[]; edgeIds: string[] } | null {
  const previous = new Map<string, Link>([[from, null]]);
  // The queue grows while it is iterated (breadth-first order).
  const queue = [from];
  for (const current of queue) {
    if (current === to) {
      return rebuild(previous, to);
    }
    for (const step of adjacency.get(current) ?? []) {
      if (!previous.has(step.to)) {
        previous.set(step.to, { node: current, edgeId: step.edgeId });
        queue.push(step.to);
      }
    }
  }
  return null;
}

/**
 * Finds a shortest path from one node to another, following the direction
 * of calls and imports. Between two functions only calls are followed; when
 * an end is a file the search runs between files (imports, and calls lifted
 * to their files). When no path goes that way, the opposite direction is
 * tried and the result is marked `reversed`.
 *
 * @param snapshot - Graph.
 * @param fromId - Start node (file or function).
 * @param toId - End node (file or function).
 * @returns The path, or `null` when the nodes are not connected either way.
 */
export function findShortestPath(
  snapshot: GraphSnapshot,
  fromId: string,
  toId: string,
): GraphPath | null {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const fromNode = byId.get(fromId);
  const toNode = byId.get(toId);
  if (fromNode === undefined || toNode === undefined || fromId === toId) {
    return null;
  }
  const level = fromNode.kind === 'function' && toNode.kind === 'function' ? 'function' : 'file';
  const start = level === 'file' && fromNode.kind === 'function' ? fromNode.fileId : fromId;
  const end = level === 'file' && toNode.kind === 'function' ? toNode.fileId : toId;
  if (start === end) {
    return null;
  }
  const adjacency = buildAdjacency(snapshot, level);
  const forward = search(adjacency, start, end);
  if (forward !== null) {
    return { ...forward, reversed: false, level };
  }
  const backward = search(adjacency, end, start);
  return backward === null ? null : { ...backward, reversed: true, level };
}

/** How a path is drawn on the canvas. */
export interface PathDisplay {
  /** Displayed nodes on the path. */
  readonly nodeIds: ReadonlySet<string>;
  /** The two ends of the path. */
  readonly endIds: ReadonlySet<string>;
  /** Containers (folders, files) of path nodes: kept lit, not highlighted. */
  readonly containerIds: ReadonlySet<string>;
  /** Consecutive pairs of the path, as `source\u0000target`. */
  readonly steps: ReadonlySet<string>;
}

/**
 * Works out which canvas nodes and edges show a path.
 *
 * @param nodes - Displayed nodes (with their parents).
 * @param path - Path to show.
 * @returns What to highlight.
 */
export function getPathDisplay(
  nodes: readonly { readonly id: string; readonly parentId?: string | undefined }[],
  path: GraphPath,
): PathDisplay {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  const containerIds = new Set<string>();
  for (const id of path.nodeIds) {
    for (let parent = parentOf.get(id); parent !== undefined; parent = parentOf.get(parent)) {
      containerIds.add(parent);
    }
  }
  const steps = new Set<string>();
  path.nodeIds.forEach((id, index) => {
    const next = path.nodeIds[index + 1];
    if (next !== undefined) {
      steps.add(pathStepKey(id, next));
    }
  });
  const first = path.nodeIds[0];
  const last = path.nodeIds[path.nodeIds.length - 1];
  return {
    nodeIds: new Set(path.nodeIds),
    endIds: new Set([first, last].filter((id): id is string => id !== undefined)),
    containerIds,
    steps,
  };
}

/**
 * Key of a step between two nodes, to match canvas edges.
 *
 * @param source - Origin node id.
 * @param target - Destination node id.
 * @returns The key.
 */
export function pathStepKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

/**
 * Class of a canvas node while a path is shown: path nodes are highlighted
 * (its ends more), their containers stay as they are and the rest is dimmed.
 *
 * @param nodeId - Canvas node id.
 * @param display - Shown path, or `null`.
 * @returns The class names, if any.
 */
export function pathClassOfNode(nodeId: string, display: PathDisplay | null): string | undefined {
  if (display === null) {
    return undefined;
  }
  if (display.endIds.has(nodeId)) {
    return 'cg-path-node cg-path-end';
  }
  if (display.nodeIds.has(nodeId)) {
    return 'cg-path-node';
  }
  return display.containerIds.has(nodeId) ? undefined : 'cg-focus-dimmed';
}
