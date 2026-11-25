/**
 * Graph export: which files an export covers and the Mermaid text of a
 * graph. Pure, so it is unit-tested (images are captured in `useGraphExport`).
 */
import type { FileGraphNode, FunctionGraphNode, GraphSnapshot, RelPath } from '../shared';

/** What an export covers. */
export type ExportScope = 'all' | 'view' | 'selected';

/** File format of an export. */
export type ExportFormat = 'png' | 'svg' | 'mermaid';

/** Detail of a Mermaid diagram. */
export type MermaidLevel = 'files' | 'functions';

/** Options of a Mermaid diagram. */
export interface MermaidOptions {
  readonly level: MermaidLevel;
  /** Whether import edges are drawn (file level only). */
  readonly imports: boolean;
  /** Whether call edges are drawn. */
  readonly calls: boolean;
}

/** Above this many nodes Mermaid diagrams become hard to render and read. */
export const MERMAID_NODE_WARNING = 300;

/**
 * Lists the files under a set of selected files and folders.
 *
 * @param snapshot - Graph.
 * @param selection - Selected file or folder paths.
 * @returns Ids of the selected files.
 */
export function selectFiles(snapshot: GraphSnapshot, selection: Iterable<RelPath>): Set<string> {
  const paths = [...selection];
  return new Set(
    snapshot.nodes
      .filter(
        (node): node is FileGraphNode =>
          node.kind === 'file' &&
          paths.some((path) => node.filePath === path || node.filePath.startsWith(`${path}/`)),
      )
      .map((file) => file.id),
  );
}

/**
 * Keeps the part of a graph made of some files, their functions and the
 * edges between them.
 *
 * @param snapshot - Graph.
 * @param fileIds - Files to keep.
 * @returns The sub-graph.
 */
export function subgraphOfFiles(
  snapshot: GraphSnapshot,
  fileIds: ReadonlySet<string>,
): GraphSnapshot {
  const nodes = snapshot.nodes.filter((node) =>
    fileIds.has(node.kind === 'function' ? node.fileId : node.id),
  );
  const kept = new Set(nodes.map((node) => node.id));
  return {
    version: snapshot.version,
    nodes,
    edges: snapshot.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
  };
}

/**
 * Escapes a label for Mermaid (inside double quotes).
 *
 * @param text - Label.
 * @returns The escaped label.
 */
function mermaidLabel(text: string): string {
  return `"${text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;')}"`;
}

/**
 * Returns the folder of a path.
 *
 * @param path - File path.
 * @returns Its folder (`''` at the root).
 */
function folderOf(path: RelPath): RelPath {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? '' : path.slice(0, separator);
}

/**
 * Writes a graph as a Mermaid flowchart: files grouped by folder (file
 * level) or functions grouped by file (function level). Calls between two
 * files are merged into one edge labeled with their count.
 *
 * @param snapshot - Graph to write.
 * @param options - Level and edge kinds.
 * @returns The Mermaid text.
 */
export function toMermaid(snapshot: GraphSnapshot, options: MermaidOptions): string {
  const ids = new Map<string, string>();
  /**
   * Short Mermaid id of a node.
   *
   * @param nodeId - Graph node id.
   * @returns `n0`, `n1`…
   */
  const idOf = (nodeId: string): string => {
    let id = ids.get(nodeId);
    if (id === undefined) {
      id = `n${String(ids.size)}`;
      ids.set(nodeId, id);
    }
    return id;
  };
  const files = snapshot.nodes.filter((node): node is FileGraphNode => node.kind === 'file');
  const functions = snapshot.nodes.filter(
    (node): node is FunctionGraphNode => node.kind === 'function',
  );
  const fileOf = new Map<string, string>(functions.map((fn) => [fn.id, fn.fileId]));
  const lines = ['flowchart LR'];

  if (options.level === 'files') {
    const byFolder = new Map<string, FileGraphNode[]>();
    for (const file of files) {
      const folder = folderOf(file.filePath);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
    }
    let group = 0;
    for (const [folder, members] of [...byFolder].sort((a, b) => a[0].localeCompare(b[0]))) {
      const indent = folder === '' ? '  ' : '    ';
      if (folder !== '') {
        lines.push(`  subgraph g${String(group)}[${mermaidLabel(folder)}]`);
        group += 1;
      }
      for (const file of members) {
        lines.push(`${indent}${idOf(file.id)}[${mermaidLabel(file.label)}]`);
      }
      if (folder !== '') {
        lines.push('  end');
      }
    }
    const calls = new Map<string, number>();
    for (const edge of snapshot.edges) {
      if (edge.kind === 'import' && options.imports) {
        lines.push(`  ${idOf(edge.source)} -.-> ${idOf(edge.target)}`);
      } else if (edge.kind === 'call' && options.calls) {
        const from = fileOf.get(edge.source);
        const to = fileOf.get(edge.target);
        if (from !== undefined && to !== undefined && from !== to) {
          const key = `${from}\u0000${to}`;
          calls.set(key, (calls.get(key) ?? 0) + 1);
        }
      }
    }
    for (const [key, count] of calls) {
      const [from = '', to = ''] = key.split('\u0000');
      const label = count > 1 ? `|${mermaidLabel(`×${String(count)}`)}|` : '';
      lines.push(`  ${idOf(from)} -->${label} ${idOf(to)}`);
    }
    return `${lines.join('\n')}\n`;
  }

  let group = 0;
  for (const file of files) {
    const members = functions.filter((fn) => fn.fileId === file.id);
    if (members.length === 0) {
      continue;
    }
    lines.push(`  subgraph g${String(group)}[${mermaidLabel(file.filePath)}]`);
    group += 1;
    for (const fn of members) {
      lines.push(`    ${idOf(fn.id)}(${mermaidLabel(fn.qualifiedName)})`);
    }
    lines.push('  end');
  }
  if (options.calls) {
    for (const edge of snapshot.edges) {
      if (edge.kind === 'call' && ids.has(edge.source) && ids.has(edge.target)) {
        lines.push(`  ${idOf(edge.source)} --> ${idOf(edge.target)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Counts the nodes a Mermaid diagram would draw.
 *
 * @param snapshot - Graph to write.
 * @param level - Detail.
 * @returns Number of nodes.
 */
export function countMermaidNodes(snapshot: GraphSnapshot, level: MermaidLevel): number {
  return snapshot.nodes.filter((node) => node.kind === (level === 'files' ? 'file' : 'function'))
    .length;
}

/**
 * Builds the default name of an exported file.
 *
 * @param format - Export format.
 * @param scope - What it covers.
 * @returns E.g. `codegraph-selection.png`.
 */
export function exportFileName(format: ExportFormat, scope: ExportScope): string {
  const suffix = { all: 'graph', view: 'view', selected: 'selection' }[scope];
  const extension = format === 'mermaid' ? 'mmd' : format;
  return `codegraph-${suffix}.${extension}`;
}
