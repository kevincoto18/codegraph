/**
 * Pure name search over the graph model.
 */
import type { GraphSnapshot } from '../shared';
import type { FolderTree } from './folders';
import { getAncestorFolderIds } from './folders';

/** Outcome of a search. */
export interface SearchResult {
  /** Ids of nodes whose name matches the query. */
  readonly matchedIds: ReadonlySet<string>;
  /** Matched ids plus the files that contain matched functions (shown undimmed). */
  readonly highlightedIds: ReadonlySet<string>;
}

/**
 * Normalizes a raw query for case-insensitive matching.
 *
 * @param query - Text typed by the user.
 * @returns The trimmed, lower-cased query.
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Finds the nodes whose name contains the query. Files match on their path;
 * functions match on their qualified name only (matching them on the file path
 * would select every function of a matching file).
 *
 * @param snapshot - Graph snapshot.
 * @param query - Raw query.
 * @returns The matches, or `null` when the query is empty (no search active).
 */
export function matchNodes(snapshot: GraphSnapshot, query: string): SearchResult | null {
  const needle = normalizeQuery(query);
  if (needle === '') {
    return null;
  }
  const matchedIds = new Set<string>();
  const highlightedIds = new Set<string>();
  for (const node of snapshot.nodes) {
    const haystack = node.kind === 'file' ? node.filePath : node.qualifiedName;
    if (!haystack.toLowerCase().includes(needle)) {
      continue;
    }
    matchedIds.add(node.id);
    highlightedIds.add(node.id);
    if (node.kind === 'function') {
      highlightedIds.add(node.fileId);
    }
  }
  return { matchedIds, highlightedIds };
}

/**
 * Adds to a search result the folders that contain highlighted files, so
 * collapsed folders hiding a match are shown as context instead of dimmed.
 *
 * @param search - Search result, or `null` without search.
 * @param folderTree - Folder hierarchy, or `null` without folder view.
 * @returns The extended result (the same object when nothing is added).
 */
export function withFolderContext(
  search: SearchResult | null,
  folderTree: FolderTree | null,
): SearchResult | null {
  if (search === null || folderTree === null) {
    return search;
  }
  const highlightedIds = new Set(search.highlightedIds);
  for (const id of search.highlightedIds) {
    for (const folderId of getAncestorFolderIds(folderTree, id)) {
      highlightedIds.add(folderId);
    }
  }
  return { matchedIds: search.matchedIds, highlightedIds };
}

/** Visual role of an element while a search is active. */
export type SearchRole = 'match' | 'context' | 'dimmed';

/**
 * Classifies a node for display while a search is active.
 *
 * @param nodeId - Node id.
 * @param search - Active search result.
 * @returns `match` for matches, `context` for files containing matches,
 *   `dimmed` for everything else.
 */
export function getSearchRole(nodeId: string, search: SearchResult): SearchRole {
  if (search.matchedIds.has(nodeId)) {
    return 'match';
  }
  return search.highlightedIds.has(nodeId) ? 'context' : 'dimmed';
}

/**
 * Resolves the search CSS class of a node.
 *
 * @param nodeId - Node id.
 * @param search - Active search, or `null` when no search is active.
 * @returns `cg-match`, `cg-context` or `cg-dimmed`, or `undefined` without search.
 */
export function searchClassOfNode(nodeId: string, search: SearchResult | null): string | undefined {
  return search === null ? undefined : `cg-${getSearchRole(nodeId, search)}`;
}

/**
 * Resolves the search CSS class of an edge: dimmed unless both endpoints are highlighted.
 *
 * @param edge - Edge endpoints.
 * @param edge.source - Source node id.
 * @param edge.target - Target node id.
 * @param search - Active search, or `null` when no search is active.
 * @returns `cg-dimmed` or `undefined`.
 */
export function searchClassOfEdge(
  edge: { readonly source: string; readonly target: string },
  search: SearchResult | null,
): string | undefined {
  if (search === null) {
    return undefined;
  }
  return search.highlightedIds.has(edge.source) && search.highlightedIds.has(edge.target)
    ? undefined
    : 'cg-dimmed';
}

/**
 * Formats the number of search matches.
 *
 * @param count - Number of matches.
 * @returns Human-readable count.
 */
export function formatMatchCount(count: number): string {
  if (count === 0) {
    return 'No matches';
  }
  return count === 1 ? '1 match' : `${String(count)} matches`;
}
