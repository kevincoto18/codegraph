/**
 * Pure helpers that build stable identifiers for graph elements.
 *
 * @remarks Ids never include line numbers, so editing code above a function
 * does not change its id and the webview can keep the node's position.
 */
import type { EdgeKind, RelPath } from './types';

/** Separator between a file path and a function's qualified name. */
const FUNCTION_ID_SEPARATOR = '#';

/** Suffix separator used to disambiguate functions with the same name. */
const OCCURRENCE_SEPARATOR = '~';

/**
 * Normalizes a relative path to POSIX format.
 *
 * @param path - Relative path that may contain Windows separators.
 * @returns The same path using forward slashes, without a leading `./`.
 */
export function toPosixPath(path: string): RelPath {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Builds the id of a file node.
 *
 * @param filePath - Workspace-relative POSIX path of the file.
 * @returns The file node id.
 */
export function createFileId(filePath: RelPath): string {
  return filePath;
}

/**
 * Builds the id of a function node.
 *
 * @param filePath - Workspace-relative POSIX path of the containing file.
 * @param qualifiedName - Function name including its container (e.g. `Class.method`).
 * @param occurrence - 1-based index among functions with the same qualified name
 *   in the same file; values greater than 1 add a `~n` suffix.
 * @returns The function node id, e.g. `src/a.ts#Class.method` or `src/a.ts#init~2`.
 */
export function createFunctionId(filePath: RelPath, qualifiedName: string, occurrence = 1): string {
  const baseId = `${filePath}${FUNCTION_ID_SEPARATOR}${qualifiedName}`;
  return occurrence > 1 ? `${baseId}${OCCURRENCE_SEPARATOR}${String(occurrence)}` : baseId;
}

/**
 * Builds the id of an edge. Two edges of the same kind between the same nodes
 * share an id, which deduplicates repeated imports or calls.
 *
 * @param kind - Relationship type.
 * @param source - Id of the origin node.
 * @param target - Id of the destination node.
 * @returns The edge id, e.g. `call:src/a.ts#foo->src/b.ts#bar`.
 */
export function createEdgeId(kind: EdgeKind, source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}
