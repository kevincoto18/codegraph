/**
 * Pure helpers to apply incremental graph patches in the webview.
 */
import type { GraphNode, GraphPatch, GraphSnapshot } from '../shared';

/** How a patch relates to the snapshot currently held. */
export type PatchOrder = 'next' | 'stale' | 'gap';

/** Node properties that change when code merely moves (ignored for "changed" feedback). */
const POSITION_ONLY_KEYS: ReadonlySet<string> = new Set(['line', 'endLine']);

/**
 * Classifies a patch against the current snapshot version.
 *
 * @param snapshot - Snapshot currently held.
 * @param patch - Incoming patch.
 * @returns `next` if it directly follows the snapshot, `stale` if it is not
 *   newer, `gap` if intermediate patches were missed.
 */
export function classifyPatch(snapshot: GraphSnapshot, patch: GraphPatch): PatchOrder {
  if (patch.version <= snapshot.version) {
    return 'stale';
  }
  return patch.version === snapshot.version + 1 ? 'next' : 'gap';
}

/**
 * Merges upserts and removals into a list of elements identified by `id`.
 * Existing elements keep their order; new elements are appended.
 *
 * @param items - Current elements.
 * @param upserts - Added or replaced elements.
 * @param removedIds - Ids of removed elements.
 * @returns A new array.
 */
export function mergeById<T extends { readonly id: string }>(
  items: readonly T[],
  upserts: readonly T[],
  removedIds: readonly string[],
): T[] {
  const removed = new Set(removedIds);
  const upsertsById = new Map(upserts.map((item) => [item.id, item]));
  const existingIds = new Set(items.map((item) => item.id));

  const merged = items
    .filter((item) => !removed.has(item.id))
    .map((item) => upsertsById.get(item.id) ?? item);
  for (const item of upserts) {
    if (!existingIds.has(item.id)) {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Applies a patch to a snapshot.
 *
 * @param snapshot - Current snapshot.
 * @param patch - Patch that follows it.
 * @returns The new snapshot, stamped with the patch version.
 */
export function applyPatch(snapshot: GraphSnapshot, patch: GraphPatch): GraphSnapshot {
  return {
    version: patch.version,
    nodes: mergeById(snapshot.nodes, patch.upsertNodes, patch.removeNodeIds),
    edges: mergeById(snapshot.edges, patch.upsertEdges, patch.removeEdgeIds),
  };
}

/**
 * Checks whether two versions of a node differ in more than their line numbers.
 *
 * @param before - Previous node.
 * @param after - Updated node.
 * @returns `true` for meaningful changes (name, kind, export, functions…).
 */
function hasMeaningfulChange(before: GraphNode, after: GraphNode): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (POSITION_ONLY_KEYS.has(key)) {
      continue;
    }
    const a = (before as unknown as Record<string, unknown>)[key];
    const b = (after as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return true;
    }
  }
  return false;
}

/**
 * Lists the nodes a patch adds or meaningfully modifies, ignoring nodes that
 * only moved to other lines (e.g. because code was inserted above them).
 *
 * @param previous - Snapshot before the patch.
 * @param patch - Applied patch.
 * @returns Ids of new or changed nodes.
 */
export function getChangedNodeIds(previous: GraphSnapshot, patch: GraphPatch): Set<string> {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const changed = new Set<string>();
  for (const node of patch.upsertNodes) {
    const before = previousById.get(node.id);
    if (before === undefined || hasMeaningfulChange(before, node)) {
      changed.add(node.id);
    }
  }
  return changed;
}

/**
 * Appends a CSS class to the nodes whose id is in a set.
 *
 * @param nodes - Nodes to decorate.
 * @param ids - Ids of the nodes to mark.
 * @param className - Class to append.
 * @returns The same array if no node is marked, otherwise decorated copies.
 */
export function addClassToNodes<T extends { readonly id: string; readonly className?: string }>(
  nodes: readonly T[],
  ids: ReadonlySet<string>,
  className: string,
): readonly T[] {
  if (ids.size === 0) {
    return nodes;
  }
  return nodes.map((node) =>
    ids.has(node.id) ? { ...node, className: `${node.className ?? ''} ${className}`.trim() } : node,
  );
}
