/**
 * Linear-time layered (Sugiyama-style) layout for directed graphs.
 *
 * Steps: break cycles (DFS back edges), assign ranks by longest path, reduce
 * crossings with a few barycenter sweeps, then stack each layer centered on a
 * common axis. Unlike dagre, every step is O(V + E) (plus sorting), so graphs
 * with thousands of nodes lay out in milliseconds instead of minutes.
 */

/** A node to place. */
export interface LayeredNode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** Parameters of the layered layout. */
export interface LayeredLayoutOptions {
  /** Left-to-right (ranks are columns) or top-to-bottom (ranks are rows). */
  readonly direction: 'LR' | 'TB';
  /** Gap between nodes of the same rank, in pixels. */
  readonly nodeSeparation: number;
  /** Gap between ranks, in pixels. */
  readonly rankSeparation: number;
  /** Number of barycenter sweeps used to reduce edge crossings. */
  readonly sweeps: number;
}

/** Top-left position of a placed node. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Adjacency lists of a graph, indexed by node index. */
interface Adjacency {
  readonly outgoing: number[][];
  readonly incoming: number[][];
}

/**
 * Builds adjacency lists, ignoring self-loops, duplicates and unknown ids.
 *
 * @param count - Number of nodes.
 * @param indexById - Node index by id.
 * @param edges - `[source, target]` id pairs.
 * @returns Outgoing and incoming neighbours of every node.
 */
function buildAdjacency(
  count: number,
  indexById: ReadonlyMap<string, number>,
  edges: readonly (readonly [string, string])[],
): Adjacency {
  const outgoing: number[][] = Array.from({ length: count }, () => []);
  const incoming: number[][] = Array.from({ length: count }, () => []);
  const seen = new Set<number>();
  for (const [sourceId, targetId] of edges) {
    const source = indexById.get(sourceId);
    const target = indexById.get(targetId);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const key = source * count + target;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    outgoing[source]?.push(target);
    incoming[target]?.push(source);
  }
  return { outgoing, incoming };
}

/**
 * Finds a set of edges whose removal makes the graph acyclic (DFS back edges),
 * using an explicit stack so deep graphs never overflow the call stack.
 *
 * @param outgoing - Outgoing neighbours of every node.
 * @returns Back edges encoded as `source * count + target`.
 */
export function findBackEdges(outgoing: readonly (readonly number[])[]): Set<number> {
  const count = outgoing.length;
  const state = new Uint8Array(count); // 0 = unvisited, 1 = on stack, 2 = done
  const backEdges = new Set<number>();
  const stack: number[] = [];
  const cursor = new Int32Array(count);

  for (let root = 0; root < count; root += 1) {
    if (state[root] !== 0) {
      continue;
    }
    state[root] = 1;
    stack.push(root);
    while (stack.length > 0) {
      const node = stack[stack.length - 1] ?? 0;
      const neighbours = outgoing[node] ?? [];
      const next = cursor[node] ?? 0;
      if (next < neighbours.length) {
        cursor[node] = next + 1;
        const neighbour = neighbours[next] ?? 0;
        if (state[neighbour] === 1) {
          backEdges.add(node * count + neighbour);
        } else if (state[neighbour] === 0) {
          state[neighbour] = 1;
          stack.push(neighbour);
        }
      } else {
        state[node] = 2;
        stack.pop();
      }
    }
  }
  return backEdges;
}

/**
 * Assigns ranks by longest path from the sources of the acyclic graph.
 *
 * @param adjacency - Graph adjacency.
 * @param backEdges - Edges ignored to break cycles.
 * @returns Rank of every node (0 = leftmost/topmost).
 */
export function assignRanks(adjacency: Adjacency, backEdges: ReadonlySet<number>): Int32Array {
  const count = adjacency.outgoing.length;
  const inDegree = new Int32Array(count);
  const forward: number[][] = Array.from({ length: count }, () => []);
  adjacency.outgoing.forEach((targets, source) => {
    for (const target of targets) {
      if (!backEdges.has(source * count + target)) {
        forward[source]?.push(target);
        inDegree[target] = (inDegree[target] ?? 0) + 1;
      }
    }
  });

  const ranks = new Int32Array(count);
  const queue: number[] = [];
  for (let node = 0; node < count; node += 1) {
    if (inDegree[node] === 0) {
      queue.push(node);
    }
  }
  // The array iterator re-reads the length, so nodes pushed while iterating are visited too.
  for (const node of queue) {
    for (const target of forward[node] ?? []) {
      ranks[target] = Math.max(ranks[target] ?? 0, (ranks[node] ?? 0) + 1);
      inDegree[target] = (inDegree[target] ?? 0) - 1;
      if (inDegree[target] === 0) {
        queue.push(target);
      }
    }
  }
  return ranks;
}

/**
 * Reorders nodes inside each layer by the average position of their neighbours
 * (barycenter heuristic), alternating downward and upward sweeps.
 *
 * @param layers - Node indexes per rank (reordered in place).
 * @param adjacency - Graph adjacency.
 * @param sweeps - Number of sweeps.
 */
export function reduceCrossings(layers: number[][], adjacency: Adjacency, sweeps: number): void {
  const count = adjacency.outgoing.length;
  const position = new Float64Array(count);
  /**
   * Records the index of every node of a layer as its position.
   *
   * @param layer - Node indexes in their current order.
   */
  const syncPositions = (layer: readonly number[]): void => {
    layer.forEach((node, index) => {
      position[node] = index;
    });
  };
  layers.forEach(syncPositions);

  const barycenters = new Float64Array(count);
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const downward = sweep % 2 === 0;
    const order = downward ? layers : [...layers].reverse();
    for (const layer of order) {
      for (const node of layer) {
        const neighbours = downward ? adjacency.incoming[node] : adjacency.outgoing[node];
        const list = neighbours !== undefined && neighbours.length > 0 ? neighbours : null;
        barycenters[node] =
          list === null
            ? (position[node] ?? 0)
            : list.reduce((sum, neighbour) => sum + (position[neighbour] ?? 0), 0) / list.length;
      }
      layer.sort((a, b) => (barycenters[a] ?? 0) - (barycenters[b] ?? 0) || a - b);
      syncPositions(layer);
    }
  }
}

/**
 * Lays out a directed graph in layers.
 *
 * @param nodes - Nodes with their sizes (input order breaks ties deterministically).
 * @param edges - `[source, target]` id pairs.
 * @param options - Direction, gaps and number of sweeps.
 * @returns Top-left position of every node, by id.
 */
export function layoutLayered(
  nodes: readonly LayeredNode[],
  edges: readonly (readonly [string, string])[],
  options: LayeredLayoutOptions,
): Map<string, Point> {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const adjacency = buildAdjacency(nodes.length, indexById, edges);
  const ranks = assignRanks(adjacency, findBackEdges(adjacency.outgoing));

  const layers: number[][] = [];
  ranks.forEach((rank, node) => {
    (layers[rank] ??= []).push(node);
  });
  const denseLayers = layers.filter((layer) => layer.length > 0);
  reduceCrossings(denseLayers, adjacency, options.sweeps);

  const horizontal = options.direction === 'LR';
  /**
   * Size of a node along the rank axis.
   *
   * @param node - Node.
   * @returns Width for LR, height for TB.
   */
  const along = (node: LayeredNode): number => (horizontal ? node.width : node.height);
  /**
   * Size of a node across the rank axis.
   *
   * @param node - Node.
   * @returns Height for LR, width for TB.
   */
  const across = (node: LayeredNode): number => (horizontal ? node.height : node.width);

  const positions = new Map<string, Point>();
  let rankOffset = 0;
  for (const layer of denseLayers) {
    const members = layer
      .map((index) => nodes[index])
      .filter((node): node is LayeredNode => node !== undefined);
    const thickness = Math.max(...members.map(along));
    const extent =
      members.reduce((sum, node) => sum + across(node), 0) +
      options.nodeSeparation * (members.length - 1);
    let crossOffset = -extent / 2; // center every layer on the same axis
    for (const node of members) {
      positions.set(
        node.id,
        horizontal ? { x: rankOffset, y: crossOffset } : { x: crossOffset, y: rankOffset },
      );
      crossOffset += across(node) + options.nodeSeparation;
    }
    rankOffset += thickness + options.rankSeparation;
  }
  return positions;
}
