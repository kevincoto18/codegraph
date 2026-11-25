/**
 * Maps changed lines to the functions of the graph that contain them.
 */
import type {
  FunctionGraphNode,
  GraphSnapshot,
  RelPath,
  ReviewFile,
  ReviewFileStatus,
  ReviewFunction,
} from '../../shared';
import { createFileId } from '../../shared';
import type { ParsedDiff } from './diffParser';

/** A changed file as read from git. */
export interface FileChange {
  readonly filePath: RelPath;
  readonly status: ReviewFileStatus;
  /** Its diff, or `null` for a new file git has no diff for (untracked). */
  readonly diff: ParsedDiff | null;
  /** Number of lines of a new file without diff. */
  readonly lineCount?: number;
}

/** Functions of each file, by file id, sorted by start line. */
export type FunctionIndex = ReadonlyMap<string, readonly FunctionGraphNode[]>;

/**
 * Indexes the functions of a graph by file.
 *
 * @param snapshot - Graph.
 * @returns Functions by file id.
 */
export function indexFunctions(snapshot: GraphSnapshot): FunctionIndex {
  const index = new Map<string, FunctionGraphNode[]>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'function') {
      const list = index.get(node.fileId) ?? [];
      list.push(node);
      index.set(node.fileId, list);
    }
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.line - b.line);
  }
  return index;
}

/**
 * Innermost function whose range contains every given line.
 *
 * @param functions - Functions of the file.
 * @param first - First line.
 * @param last - Last line.
 * @returns The function, or `undefined` when the lines are outside every function.
 */
function innermost(
  functions: readonly FunctionGraphNode[],
  first: number,
  last: number,
): FunctionGraphNode | undefined {
  let best: FunctionGraphNode | undefined;
  for (const fn of functions) {
    if (fn.line > first) {
      break;
    }
    if (
      last <= fn.endLine &&
      (best === undefined || fn.endLine - fn.line < best.endLine - best.line)
    ) {
      best = fn;
    }
  }
  return best;
}

/**
 * Builds the review entry of a changed file.
 *
 * @param change - The change read from git.
 * @param fileIds - Ids of the files of the graph.
 * @param functions - Functions by file id.
 * @returns The review entry.
 */
export function mapFileChange(
  change: FileChange,
  fileIds: ReadonlySet<string>,
  functions: FunctionIndex,
): ReviewFile {
  const fileId = createFileId(change.filePath);
  const inGraph = fileIds.has(fileId);
  const fileFunctions = functions.get(fileId) ?? [];
  const counts = new Map<string, { added: number; removed: number }>();
  let topLevel = false;

  /**
   * Adds changed lines to a function, or to the top-level code.
   *
   * @param fn - Containing function, if any.
   * @param added - Added lines.
   * @param removed - Removed lines.
   */
  const count = (fn: FunctionGraphNode | undefined, added: number, removed: number): void => {
    if (fn === undefined) {
      topLevel = true;
      return;
    }
    const entry = counts.get(fn.id) ?? { added: 0, removed: 0 };
    entry.added += added;
    entry.removed += removed;
    counts.set(fn.id, entry);
  };

  let added: number;
  let removed = 0;
  if (change.diff === null) {
    // New file without diff: everything in it is new.
    added = change.lineCount ?? 0;
    for (const fn of fileFunctions) {
      count(fn, fn.endLine - fn.line + 1, 0);
    }
    topLevel = inGraph;
  } else {
    added = change.diff.added;
    removed = change.diff.removed;
    const { trivialLines } = change.diff;
    for (const line of change.diff.addedLines) {
      const fn = innermost(fileFunctions, line, line);
      // Blank lines and comments outside functions change no behavior.
      if (fn !== undefined || !trivialLines.has(line)) {
        count(fn, 1, 0);
      }
    }
    for (const removal of change.diff.removals) {
      // A replaced block belongs where its new lines are; a pure removal to the
      // function it was strictly inside (the lines around the gap are both in it).
      const fn =
        removal.replacedBy !== undefined
          ? innermost(fileFunctions, removal.replacedBy, removal.replacedBy)
          : removal.before > 1
            ? innermost(fileFunctions, removal.before - 1, removal.before)
            : undefined;
      if (fn !== undefined || !removal.trivial) {
        count(fn, 0, removal.count);
      }
    }
    if (change.status === 'added') {
      topLevel = inGraph;
    }
  }

  const touched: ReviewFunction[] = fileFunctions
    .filter((fn) => counts.has(fn.id))
    .map((fn) => {
      const entry = counts.get(fn.id) ?? { added: 0, removed: 0 };
      return { nodeId: fn.id, added: entry.added, removed: entry.removed };
    });
  return {
    filePath: change.filePath,
    status: change.status,
    added,
    removed,
    inGraph,
    topLevel: inGraph && topLevel,
    functions: inGraph ? touched : [],
  };
}

/**
 * Maps every changed file, analyzed files first.
 *
 * @param snapshot - Current graph.
 * @param changes - Changes read from git.
 * @returns The review entries, sorted by path within each group.
 */
export function mapChanges(snapshot: GraphSnapshot, changes: readonly FileChange[]): ReviewFile[] {
  const fileIds = new Set(snapshot.nodes.filter((node) => node.kind === 'file').map((n) => n.id));
  const functions = indexFunctions(snapshot);
  return changes
    .map((change) => mapFileChange(change, fileIds, functions))
    .sort((a, b) => Number(b.inGraph) - Number(a.inGraph) || a.filePath.localeCompare(b.filePath));
}
