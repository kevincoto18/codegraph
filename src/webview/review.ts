/**
 * Impact of a change review on the graph: what changed, what uses it (up to
 * a depth), how the canvas shows it and the Markdown summary for a pull
 * request.
 */
import type { GraphNode, GraphSnapshot, ReviewFile, ReviewResult } from '../shared';
import { changedNodeIds, createFileId } from '../shared';
import type { FolderTree } from './folders';
import { getAncestorFolderIds } from './folders';

/** Depths offered for the impact (levels of users followed). */
export const REVIEW_DEPTHS: readonly number[] = [1, 2, 3];

/** Default impact depth. */
export const DEFAULT_REVIEW_DEPTH = 2;

/** Impact of the changes. */
export interface ReviewImpact {
  /** Level of each reached node: 0 = changed, 1 = uses a changed node, 2… = indirect. */
  readonly levels: ReadonlyMap<string, number>;
  /** Number of changed nodes. */
  readonly changed: number;
  /** Number of nodes affected (level ≥ 1). */
  readonly affected: number;
}

/** Reverse adjacency: who imports or calls each node. */
export type UsersIndex = ReadonlyMap<string, readonly string[]>;

/**
 * Indexes who uses each node (sources of the imports and calls targeting it).
 *
 * @param snapshot - Graph.
 * @returns Users by node id.
 */
export function indexUsers(snapshot: GraphSnapshot): UsersIndex {
  const users = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (edge.source === edge.target) {
      continue;
    }
    const list = users.get(edge.target) ?? [];
    list.push(edge.source);
    users.set(edge.target, list);
  }
  return users;
}

/**
 * Follows the users of some nodes, breadth first.
 *
 * @param users - Users by node id.
 * @param seeds - Starting nodes (level 0).
 * @param depth - Levels of users to follow.
 * @returns The level of every reached node.
 */
function followUsers(
  users: UsersIndex,
  seeds: Iterable<string>,
  depth: number,
): Map<string, number> {
  const levels = new Map<string, number>();
  let frontier: string[] = [];
  for (const seed of seeds) {
    levels.set(seed, 0);
    frontier.push(seed);
  }
  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const user of users.get(id) ?? []) {
        if (!levels.has(user)) {
          levels.set(user, level);
          next.push(user);
        }
      }
    }
    frontier = next;
  }
  return levels;
}

/**
 * Computes what the changes affect.
 *
 * @param users - Users by node id ({@link indexUsers}).
 * @param changedIds - Changed nodes.
 * @param depth - Levels of users to follow.
 * @returns The impact.
 */
export function computeImpact(
  users: UsersIndex,
  changedIds: ReadonlySet<string>,
  depth: number,
): ReviewImpact {
  const levels = followUsers(users, changedIds, depth);
  return { levels, changed: changedIds.size, affected: levels.size - changedIds.size };
}

/**
 * Number of unchanged nodes a changed node affects, alone.
 *
 * @param users - Users by node id.
 * @param nodeId - Changed node.
 * @param depth - Levels of users to follow.
 * @param changedIds - Changed nodes (not counted: they are reviewed anyway).
 * @returns Its number of direct and indirect users that did not change.
 */
export function countAffected(
  users: UsersIndex,
  nodeId: string,
  depth: number,
  changedIds: ReadonlySet<string>,
): number {
  let count = 0;
  for (const id of followUsers(users, [nodeId], depth).keys()) {
    if (!changedIds.has(id)) {
      count += 1;
    }
  }
  return count;
}

/** A row of the Changes list. */
export interface ReviewEntry {
  /** Graph id of the changed function or file. */
  readonly nodeId: string;
  readonly kind: 'file' | 'function';
  /** Function or file name. */
  readonly label: string;
  /** File path. */
  readonly filePath: string;
  readonly added: number;
  readonly removed: number;
  /** Unchanged nodes it affects (direct and indirect users within the depth). */
  readonly affected: number;
  readonly status: ReviewFile['status'];
}

/**
 * Lists the changed functions and files, the riskiest first (most affected
 * nodes, then most changed lines).
 *
 * @param result - Review result.
 * @param nodesById - Graph nodes by id.
 * @param users - Users by node id.
 * @param depth - Levels of users to follow.
 * @returns The rows.
 */
export function listReviewEntries(
  result: ReviewResult,
  nodesById: ReadonlyMap<string, GraphNode>,
  users: UsersIndex,
  depth: number,
): ReviewEntry[] {
  const entries: ReviewEntry[] = [];
  const changedIds = reviewChangedIds(result);
  for (const file of result.files) {
    if (!file.inGraph) {
      continue;
    }
    for (const fn of file.functions) {
      const node = nodesById.get(fn.nodeId);
      entries.push({
        nodeId: fn.nodeId,
        kind: 'function',
        label: node?.kind === 'function' ? node.qualifiedName : fn.nodeId,
        filePath: file.filePath,
        added: fn.added,
        removed: fn.removed,
        affected: countAffected(users, fn.nodeId, depth, changedIds),
        status: file.status,
      });
    }
    // A new file is listed through its functions; the file itself only when it has none.
    if ((file.topLevel && file.status !== 'added') || file.functions.length === 0) {
      const fileId = createFileId(file.filePath);
      const slash = file.filePath.lastIndexOf('/');
      entries.push({
        nodeId: fileId,
        kind: 'file',
        label: file.filePath.slice(slash + 1),
        filePath: file.filePath,
        added: file.added,
        removed: file.removed,
        affected: countAffected(users, fileId, depth, changedIds),
        status: file.status,
      });
    }
  }
  return entries.sort(
    (a, b) =>
      b.affected - a.affected ||
      b.added + b.removed - (a.added + a.removed) ||
      a.label.localeCompare(b.label),
  );
}

/** How the canvas shows the impact. */
export interface ReviewDisplay {
  /** Level of each canvas file or function (a file takes its best function's). */
  readonly levels: ReadonlyMap<string, number>;
  /** Folders that contain reached nodes, with the best level inside. */
  readonly folders: ReadonlyMap<string, number>;
}

/**
 * Projects the impact on the canvas: a file shows the strongest level of
 * itself and its functions (they may be collapsed into it), folders show
 * whether they contain reached files.
 *
 * @param snapshot - Graph.
 * @param impact - Impact.
 * @param folderTree - Folder hierarchy, or `null` without folder view.
 * @returns The display levels.
 */
export function getReviewDisplay(
  snapshot: GraphSnapshot,
  impact: ReviewImpact,
  folderTree: FolderTree | null,
): ReviewDisplay {
  const fileOf = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'function') {
      fileOf.set(node.id, node.fileId);
    }
  }
  const levels = new Map<string, number>();
  /**
   * Keeps the strongest (lowest) level of a node.
   *
   * @param target - Map to update.
   * @param id - Node id.
   * @param level - Level to merge.
   */
  const keep = (target: Map<string, number>, id: string, level: number): void => {
    const current = target.get(id);
    if (current === undefined || level < current) {
      target.set(id, level);
    }
  };
  for (const [id, level] of impact.levels) {
    keep(levels, id, level);
    const fileId = fileOf.get(id);
    if (fileId !== undefined) {
      keep(levels, fileId, level);
    }
  }
  const folders = new Map<string, number>();
  if (folderTree !== null) {
    for (const [id, level] of levels) {
      if (fileOf.has(id)) {
        continue;
      }
      for (const folderId of getAncestorFolderIds(folderTree, id)) {
        keep(folders, folderId, level);
      }
    }
  }
  return { levels, folders };
}

/**
 * CSS class of a canvas node during a review.
 *
 * @param nodeId - Canvas node id.
 * @param type - Canvas node type.
 * @param display - Review display, or `null` without review.
 * @returns The class names, if any.
 */
export function reviewClassOfNode(
  nodeId: string,
  type: string | undefined,
  display: ReviewDisplay | null,
): string | undefined {
  if (display === null) {
    return undefined;
  }
  if (type === 'folder') {
    const level = display.folders.get(nodeId);
    return level === undefined
      ? 'cg-focus-dimmed'
      : level === 0
        ? 'cg-review-folder cg-review-folder--changed'
        : 'cg-review-folder';
  }
  const level = display.levels.get(nodeId);
  if (level === undefined) {
    return 'cg-focus-dimmed';
  }
  return level === 0
    ? 'cg-review-changed'
    : level === 1
      ? 'cg-review-direct'
      : 'cg-review-indirect';
}

/**
 * CSS class of a canvas edge during a review: edges along which the impact
 * spreads (a user toward what it uses) are highlighted, the rest dimmed.
 *
 * @param source - Source canvas id.
 * @param target - Target canvas id.
 * @param display - Review display, or `null` without review.
 * @returns The class names, if any.
 */
export function reviewClassOfEdge(
  source: string,
  target: string,
  display: ReviewDisplay | null,
): string | undefined {
  if (display === null) {
    return undefined;
  }
  const from = display.levels.get(source);
  const to = display.levels.get(target);
  return from !== undefined && to !== undefined && to < from ? 'cg-review-edge' : 'cg-focus-dimmed';
}

/**
 * Markdown summary of a review, to paste in a pull request.
 *
 * @param result - Review result.
 * @param entries - Rows of the Changes list ({@link listReviewEntries}).
 * @param impact - Impact.
 * @param depth - Levels of users followed.
 * @returns The Markdown text.
 */
export function formatReviewSummary(
  result: ReviewResult,
  entries: readonly ReviewEntry[],
  impact: ReviewImpact,
  depth: number,
): string {
  const files = result.files;
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  const lines = [
    '## Impact (CodeGraph)',
    '',
    `Compared with \`${result.base}\`: ${String(files.length)} files changed (+${String(added)} −${String(removed)}), ` +
      `${String(impact.changed)} functions/files touched, ${String(impact.affected)} affected ` +
      `within ${String(depth)} ${depth === 1 ? 'level' : 'levels'} of callers and importers.`,
    '',
  ];
  if (entries.length > 0) {
    lines.push('| Changed | File | Lines | Affected |', '| --- | --- | --- | --- |');
    for (const entry of entries.slice(0, 25)) {
      const name = entry.kind === 'function' ? `\`${entry.label}()\`` : `\`${entry.label}\``;
      lines.push(
        `| ${name} | ${entry.filePath} | +${String(entry.added)} −${String(entry.removed)} | ${String(entry.affected)} |`,
      );
    }
    if (entries.length > 25) {
      lines.push('', `…and ${String(entries.length - 25)} more.`);
    }
  }
  const outside = files.filter((file) => !file.inGraph);
  if (outside.length > 0) {
    lines.push(
      '',
      `Not analyzed: ${outside.map((file) => `${file.filePath} (${file.status})`).join(', ')}.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Ids of the nodes a review changed.
 *
 * @param result - Review result.
 * @returns The ids.
 */
export function reviewChangedIds(result: ReviewResult): Set<string> {
  return changedNodeIds(result, createFileId);
}
