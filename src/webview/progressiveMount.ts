/**
 * Mounts a large batch of new canvas nodes over several frames.
 *
 * Inserting thousands of node elements among existing ones in one React
 * commit is quadratic (React looks for the next DOM sibling of every inserted
 * element), which froze "Expand all" for seconds. Adding the new nodes in
 * chunks keeps each commit small and lets the view paint between chunks.
 * Nodes are added in layout order, so a parent is always mounted before its
 * children.
 */

/** A canvas element with an id. */
interface Identified {
  readonly id: string;
}

/** Which nodes of the latest canvas are mounted. */
export interface MountState<T extends Identified> {
  /** Latest canvas nodes. */
  readonly source: readonly T[];
  /** Nodes that were already mounted when {@link source} arrived. */
  readonly known: ReadonlySet<string>;
  /** New nodes, in layout order. */
  readonly pending: readonly string[];
  /** How many of {@link pending} are mounted. */
  readonly limit: number;
}

/** Mount options. */
export interface MountOptions {
  /** Up to this many new nodes are mounted at once. */
  readonly threshold: number;
  /** New nodes added per frame above the threshold. */
  readonly chunkSize: number;
}

/** New nodes mounted at once (below, progressive mounting is not worth it). */
/**
 * Measured on "Expand all" (headless Chrome): chunks of 150 opened 2,000- and
 * 5,000-file projects in ~1.3 s with no frame longer than ~0.35 s; chunks of
 * 300 or more were slower overall because each chunk is quadratic in its size.
 */
export const DEFAULT_MOUNT_OPTIONS: MountOptions = { threshold: 600, chunkSize: 150 };

/**
 * State of a canvas mounted all at once (first render).
 *
 * @param nodes - Canvas nodes.
 * @returns A complete mount state.
 */
export function createMountState<T extends Identified>(nodes: readonly T[]): MountState<T> {
  return {
    source: nodes,
    known: new Set(nodes.map((node) => node.id)),
    pending: [],
    limit: 0,
  };
}

/**
 * Lists the mounted node ids.
 *
 * @param state - Mount state.
 * @returns Ids of the nodes currently mounted.
 */
function mountedIds<T extends Identified>(state: MountState<T>): Set<string> {
  const ids = new Set(state.known);
  for (let index = 0; index < state.limit; index += 1) {
    const id = state.pending[index];
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Adopts a new canvas: nodes that were mounted stay mounted, and new nodes
 * are mounted at once when there are few of them, or a first chunk otherwise.
 *
 * @param state - Previous mount state.
 * @param nodes - New canvas nodes.
 * @param options - Threshold and chunk size.
 * @returns The new mount state.
 */
export function updateMountState<T extends Identified>(
  state: MountState<T>,
  nodes: readonly T[],
  options: MountOptions = DEFAULT_MOUNT_OPTIONS,
): MountState<T> {
  const mounted = mountedIds(state);
  const known = new Set<string>();
  const pending: string[] = [];
  for (const node of nodes) {
    if (mounted.has(node.id)) {
      known.add(node.id);
    } else {
      pending.push(node.id);
    }
  }
  const limit = pending.length > options.threshold ? options.chunkSize : pending.length;
  return { source: nodes, known, pending, limit };
}

/**
 * Mounts the next chunk of new nodes.
 *
 * @param state - Mount state.
 * @param options - Chunk size.
 * @returns The state with one more chunk mounted.
 */
export function growMountState<T extends Identified>(
  state: MountState<T>,
  options: MountOptions = DEFAULT_MOUNT_OPTIONS,
): MountState<T> {
  return { ...state, limit: Math.min(state.pending.length, state.limit + options.chunkSize) };
}

/**
 * Tells whether every node of the canvas is mounted.
 *
 * @param state - Mount state.
 * @returns `true` once no new node is waiting.
 */
export function isMountComplete<T extends Identified>(state: MountState<T>): boolean {
  return state.limit >= state.pending.length;
}

/**
 * Keeps the mounted nodes, in canvas order.
 *
 * @param state - Mount state.
 * @returns The nodes to render (the source itself once complete).
 */
export function selectMountedNodes<T extends Identified>(state: MountState<T>): readonly T[] {
  if (isMountComplete(state)) {
    return state.source;
  }
  const mounted = mountedIds(state);
  return state.source.filter((node) => mounted.has(node.id));
}
