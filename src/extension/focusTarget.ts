/**
 * Maps an editor location to the graph node to focus.
 */
import type { GraphSnapshot, RelPath } from '../shared';
import { createFileId } from '../shared';

/**
 * Finds the node to focus for a file, and optionally a line inside it: the
 * innermost function whose range contains the line, otherwise the file.
 *
 * @param snapshot - Current graph.
 * @param filePath - Workspace-relative POSIX path.
 * @param line - 1-based line of the cursor, if any.
 * @returns The node id, or `null` if the file is not part of the graph.
 */
export function resolveFocusTarget(
  snapshot: GraphSnapshot,
  filePath: RelPath,
  line?: number,
): string | null {
  const fileId = createFileId(filePath);
  if (!snapshot.nodes.some((node) => node.id === fileId)) {
    return null;
  }
  if (line === undefined) {
    return fileId;
  }
  let best: { id: string; span: number } | null = null;
  for (const node of snapshot.nodes) {
    if (node.kind !== 'function' || node.fileId !== fileId) {
      continue;
    }
    if (node.line <= line && line <= node.endLine) {
      const span = node.endLine - node.line;
      if (best === null || span < best.span) {
        best = { id: node.id, span };
      }
    }
  }
  return best?.id ?? fileId;
}
