/**
 * Builds the neighborhood shown by the "CodeGraph" side view: what uses the
 * center and what the center uses, one level deep.
 */
import type {
  FileGraphNode,
  FunctionGraphNode,
  GraphNode,
  GraphSnapshot,
  MiniGraph,
  MiniMode,
  MiniNode,
  MiniRelation,
} from '../shared';

/** Most neighbors drawn on each side. */
export const MINI_NEIGHBOR_LIMIT = 6;

/** Most member functions listed inside the center file. */
export const MINI_MEMBER_LIMIT = 8;

/** Connections accumulated for one neighbor. */
interface Link {
  imports: number;
  calls: number;
}

/**
 * Splits a path into folder and file name.
 *
 * @param path - Workspace-relative POSIX path.
 * @returns The folder (empty at the root) and the base name.
 */
function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { folder: '', name: path }
    : { folder: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** Whether a node was changed, in the running change review. */
type ChangedTest = (node: GraphNode) => boolean;

/**
 * Converts a graph node into a mini-graph node.
 *
 * @param node - Graph node.
 * @param isChanged - Whether a node was changed.
 * @param link - Connections with the center, for neighbors.
 * @returns The mini node.
 */
function toMiniNode(node: GraphNode, isChanged: ChangedTest, link?: Link): MiniNode {
  const base =
    node.kind === 'file'
      ? {
          id: node.id,
          kind: node.kind,
          label: splitPath(node.filePath).name,
          detail: splitPath(node.filePath).folder,
          filePath: node.filePath,
          line: node.line,
        }
      : {
          id: node.id,
          kind: node.kind,
          label: node.qualifiedName,
          detail: splitPath(node.filePath).name,
          filePath: node.filePath,
          line: node.line,
        };
  const marked = isChanged(node) ? { ...base, changed: true } : base;
  if (link === undefined) {
    return marked;
  }
  const relation: MiniRelation =
    link.imports > 0 && link.calls > 0 ? 'both' : link.imports > 0 ? 'import' : 'call';
  return { ...marked, relation, weight: link.imports + link.calls };
}

/**
 * Adds one connection to a neighbor.
 *
 * @param links - Accumulated links by neighbor id.
 * @param id - Neighbor id.
 * @param kind - Edge kind.
 */
function addLink(links: Map<string, Link>, id: string, kind: 'import' | 'call'): void {
  const link = links.get(id) ?? { imports: 0, calls: 0 };
  if (kind === 'import') {
    link.imports += 1;
  } else {
    link.calls += 1;
  }
  links.set(id, link);
}

/**
 * Sorts neighbors (most connected first, then by name) and keeps the first ones.
 *
 * @param links - Links by neighbor id.
 * @param byId - Graph nodes by id.
 * @param limit - Most neighbors kept.
 * @param isChanged - Whether a node was changed.
 * @returns The kept nodes and how many were left out.
 */
function rankNeighbors(
  links: Map<string, Link>,
  byId: ReadonlyMap<string, GraphNode>,
  limit: number,
  isChanged: ChangedTest,
): { nodes: MiniNode[]; more: number } {
  const nodes: MiniNode[] = [];
  for (const [id, link] of links) {
    const node = byId.get(id);
    if (node !== undefined) {
      nodes.push(toMiniNode(node, isChanged, link));
    }
  }
  nodes.sort(
    (a, b) =>
      (b.weight ?? 0) - (a.weight ?? 0) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
  return { nodes: nodes.slice(0, limit), more: Math.max(0, nodes.length - limit) };
}

/**
 * Builds the neighborhood of a file: files that import it or call into it,
 * and files it imports or calls into (calls lifted to their files).
 *
 * @param snapshot - Current graph.
 * @param byId - Graph nodes by id.
 * @param center - Center file.
 * @param activeId - Function under the cursor, if any.
 * @param limit - Most neighbors per side.
 * @param isChanged - Whether a node was changed.
 * @returns The mini graph.
 */
function fileNeighborhood(
  snapshot: GraphSnapshot,
  byId: ReadonlyMap<string, GraphNode>,
  center: FileGraphNode,
  activeId: string | null,
  limit: number,
  isChanged: ChangedTest,
): MiniGraph {
  /**
   * File a node belongs to.
   *
   * @param id - File or function id.
   * @returns The file id, or `undefined` for unknown nodes.
   */
  const fileOf = (id: string): string | undefined => {
    const node = byId.get(id);
    return node === undefined ? undefined : node.kind === 'function' ? node.fileId : node.id;
  };
  const incoming = new Map<string, Link>();
  const outgoing = new Map<string, Link>();
  for (const edge of snapshot.edges) {
    const from = fileOf(edge.source);
    const to = fileOf(edge.target);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    if (to === center.id) {
      addLink(incoming, from, edge.kind);
    } else if (from === center.id) {
      addLink(outgoing, to, edge.kind);
    }
  }
  const inRanked = rankNeighbors(incoming, byId, limit, isChanged);
  const outRanked = rankNeighbors(outgoing, byId, limit, isChanged);
  const members = center.functionIds
    .map((id) => byId.get(id))
    .filter((node): node is FunctionGraphNode => node?.kind === 'function')
    .sort((a, b) => a.line - b.line);
  let shown = members.slice(0, MINI_MEMBER_LIMIT);
  const active = members.find((node) => node.id === activeId);
  if (active !== undefined && !shown.includes(active)) {
    shown = [...shown.slice(0, MINI_MEMBER_LIMIT - 1), active];
  }
  return {
    mode: 'files',
    center: toMiniNode(center, isChanged),
    members: shown.map((node) => toMiniNode(node, isChanged)),
    incoming: inRanked.nodes,
    outgoing: outRanked.nodes,
    moreIncoming: inRanked.more,
    moreOutgoing: outRanked.more,
    activeId: active?.id ?? null,
    details: null,
  };
}

/**
 * Builds the neighborhood of a function: its callers and its callees.
 *
 * @param snapshot - Current graph.
 * @param byId - Graph nodes by id.
 * @param center - Center function.
 * @param limit - Most neighbors per side.
 * @param isChanged - Whether a node was changed.
 * @returns The mini graph (without details; the host adds them).
 */
function functionNeighborhood(
  snapshot: GraphSnapshot,
  byId: ReadonlyMap<string, GraphNode>,
  center: FunctionGraphNode,
  limit: number,
  isChanged: ChangedTest,
): MiniGraph {
  const incoming = new Map<string, Link>();
  const outgoing = new Map<string, Link>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'call' || edge.source === edge.target) {
      continue;
    }
    if (edge.target === center.id) {
      addLink(incoming, edge.source, 'call');
    } else if (edge.source === center.id) {
      addLink(outgoing, edge.target, 'call');
    }
  }
  const inRanked = rankNeighbors(incoming, byId, limit, isChanged);
  const outRanked = rankNeighbors(outgoing, byId, limit, isChanged);
  return {
    mode: 'functions',
    center: toMiniNode(center, isChanged),
    members: [],
    incoming: inRanked.nodes,
    outgoing: outRanked.nodes,
    moreIncoming: inRanked.more,
    moreOutgoing: outRanked.more,
    activeId: null,
    details: null,
  };
}

/**
 * Computes the mini graph around a node.
 *
 * In files mode a function id is centered on its file (and highlighted among
 * its members). In functions mode a file id has no function to center on,
 * so the result is `null`.
 *
 * @param snapshot - Current graph.
 * @param nodeId - File or function the cursor is on.
 * @param mode - Files or functions.
 * @param limit - Most neighbors per side.
 * @param changedIds - Nodes changed in the running change review.
 * @returns The mini graph, or `null` when there is nothing to center on.
 */
export function computeMiniGraph(
  snapshot: GraphSnapshot,
  nodeId: string,
  mode: MiniMode,
  limit: number = MINI_NEIGHBOR_LIMIT,
  changedIds: ReadonlySet<string> = new Set(),
): MiniGraph | null {
  const byId = new Map<string, GraphNode>(snapshot.nodes.map((node) => [node.id, node]));
  /**
   * Whether a node changed: a function itself, a file itself or one of its functions.
   *
   * @param node - Graph node.
   * @returns `true` when changed.
   */
  const isChanged: ChangedTest = (node) =>
    changedIds.has(node.id) ||
    (node.kind === 'file' && node.functionIds.some((id) => changedIds.has(id)));
  const node = byId.get(nodeId);
  if (node === undefined) {
    return null;
  }
  if (mode === 'functions') {
    return node.kind === 'function'
      ? functionNeighborhood(snapshot, byId, node, limit, isChanged)
      : null;
  }
  const file = node.kind === 'file' ? node : byId.get(node.fileId);
  if (file?.kind !== 'file') {
    return null;
  }
  return fileNeighborhood(
    snapshot,
    byId,
    file,
    node.kind === 'function' ? node.id : null,
    limit,
    isChanged,
  );
}
