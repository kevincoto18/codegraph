/**
 * Computes the incremental patch between two graph snapshots.
 */
import type { GraphEdge, GraphNode, GraphPatch, GraphSnapshot } from '../../shared';

/** Result of comparing two collections of elements identified by `id`. */
interface CollectionDiff<T> {
  readonly upserts: T[];
  readonly removedIds: string[];
}

/**
 * Computes the changes that turn `previous` into `next`.
 *
 * @param previous - Snapshot currently held by the receiver.
 * @param next - New snapshot.
 * @returns A patch stamped with `next.version`.
 */
export function diffSnapshots(previous: GraphSnapshot, next: GraphSnapshot): GraphPatch {
  const nodes = diffById<GraphNode>(previous.nodes, next.nodes);
  const edges = diffById<GraphEdge>(previous.edges, next.edges);
  return {
    version: next.version,
    upsertNodes: nodes.upserts,
    removeNodeIds: nodes.removedIds,
    upsertEdges: edges.upserts,
    removeEdgeIds: edges.removedIds,
  };
}

/**
 * Checks whether a patch carries no changes.
 *
 * @param patch - Patch to inspect.
 * @returns `true` if every change list is empty.
 */
export function isEmptyPatch(patch: Omit<GraphPatch, 'version'>): boolean {
  return (
    patch.upsertNodes.length === 0 &&
    patch.removeNodeIds.length === 0 &&
    patch.upsertEdges.length === 0 &&
    patch.removeEdgeIds.length === 0
  );
}

/**
 * Compares two collections by `id` and structural equality.
 *
 * @param previous - Old elements.
 * @param next - New elements.
 * @returns Added or modified elements and ids of removed elements.
 */
function diffById<T extends { readonly id: string }>(
  previous: readonly T[],
  next: readonly T[],
): CollectionDiff<T> {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextIds = new Set(next.map((item) => item.id));

  const upserts = next.filter((item) => {
    const old = previousById.get(item.id);
    return old === undefined || !isStructurallyEqual(old, item);
  });
  const removedIds = previous.filter((item) => !nextIds.has(item.id)).map((item) => item.id);
  return { upserts, removedIds };
}

/**
 * Deep equality for plain JSON-like values (primitives, arrays, plain objects).
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns `true` if both values have the same structure and content.
 */
export function isStructurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => isStructurallyEqual(item, b[index]))
    );
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  return (
    aKeys.length === Object.keys(bRecord).length &&
    aKeys.every(
      (key) => Object.hasOwn(bRecord, key) && isStructurallyEqual(aRecord[key], bRecord[key]),
    )
  );
}
