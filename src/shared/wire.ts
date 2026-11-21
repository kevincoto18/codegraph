/**
 * Compact wire format of a full graph, used by the `graph/init` messages.
 *
 * @remarks A plain {@link GraphSnapshot} repeats long strings in every node
 * and edge (ids embed file paths, function nodes repeat their file path and
 * id, edges repeat both endpoint ids). The wire format sends each file path
 * once, derives ids and labels on the receiving side and encodes edges as
 * numbers that index the node list. Large graphs are split into chunks so no
 * single message has to be serialized at once. Environment-agnostic.
 */
import { createEdgeId, createFileId, createFunctionId } from './ids';
import type {
  EdgeKind,
  FileGraphNode,
  FunctionGraphNode,
  FunctionKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  RelPath,
} from './types';

/**
 * A function: `[qualifiedName, kind, line, endLine, exported, id?]`. The id is
 * only sent when it cannot be derived from the file path and the name.
 */
export type WireFunction =
  | readonly [string, number, number, number, 0 | 1]
  | readonly [string, number, number, number, 0 | 1, string];

/**
 * A file and its functions: `[filePath, functions, label?]`. The label is only
 * sent when it differs from the file name.
 */
export type WireFile =
  readonly [RelPath, readonly WireFunction[]] | readonly [RelPath, readonly WireFunction[], string];

/** Part of an encoded graph. */
export interface WireGraphChunk {
  /** Files with their functions, in snapshot order. */
  readonly files: readonly WireFile[];
  /**
   * Edges as a flat list of quadruples `[kind, source, target, line]`, where
   * source and target index the nodes of the whole graph (each file followed
   * by its functions) and line 0 means "no line".
   */
  readonly edges: readonly number[];
}

/** Limits used to split a graph into chunks. */
export interface ChunkLimits {
  /** Maximum number of nodes (files + functions) per chunk. */
  readonly maxNodes: number;
  /** Maximum number of edges per chunk. */
  readonly maxEdges: number;
}

/** Default chunk limits: a few hundred kilobytes per message. */
export const DEFAULT_CHUNK_LIMITS: ChunkLimits = { maxNodes: 4000, maxEdges: 15000 };

/** Numeric codes of function kinds. */
const FUNCTION_KINDS: readonly FunctionKind[] = ['function', 'arrow', 'method'];

/** Numeric codes of edge kinds. */
const EDGE_KINDS: readonly EdgeKind[] = ['import', 'call'];

/** Number of numbers that encode one edge. */
const EDGE_STRIDE = 4;

/**
 * Returns the file name of a workspace-relative path.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @returns The part after the last `/`.
 */
function baseName(filePath: RelPath): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

/**
 * Derives the ids of a file's functions from their qualified names, the same
 * way the linker assigns them (repeated names get an occurrence index).
 *
 * @param filePath - Workspace-relative POSIX path.
 * @param qualifiedNames - Qualified names in source order.
 * @returns The derived ids, in the same order.
 */
function deriveFunctionIds(filePath: RelPath, qualifiedNames: readonly string[]): string[] {
  const occurrences = new Map<string, number>();
  return qualifiedNames.map((name) => {
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    return createFunctionId(filePath, name, occurrence);
  });
}

/**
 * Encodes a snapshot into one or more chunks.
 *
 * @param snapshot - Graph to encode; every function must belong to a file node.
 * @param limits - Chunk size limits.
 * @returns At least one chunk.
 */
export function encodeSnapshot(
  snapshot: GraphSnapshot,
  limits: ChunkLimits = DEFAULT_CHUNK_LIMITS,
): WireGraphChunk[] {
  const functionsById = new Map<string, FunctionGraphNode>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'function') {
      functionsById.set(node.id, node);
    }
  }

  const indexById = new Map<string, number>();
  const fileChunks: WireFile[][] = [[]];
  let nodesInChunk = 0;
  for (const node of snapshot.nodes) {
    if (node.kind !== 'file') {
      continue;
    }
    const functions = node.functionIds
      .map((id) => functionsById.get(id))
      .filter((fn): fn is FunctionGraphNode => fn !== undefined);
    const nodeCount = functions.length + 1;
    if (nodesInChunk > 0 && nodesInChunk + nodeCount > limits.maxNodes) {
      fileChunks.push([]);
      nodesInChunk = 0;
    }
    nodesInChunk += nodeCount;
    indexById.set(node.id, indexById.size);
    const derivedIds = deriveFunctionIds(
      node.filePath,
      functions.map((fn) => fn.qualifiedName),
    );
    const wireFunctions = functions.map((fn, position): WireFunction => {
      indexById.set(fn.id, indexById.size);
      const row = [
        fn.qualifiedName,
        FUNCTION_KINDS.indexOf(fn.functionKind),
        fn.line,
        fn.endLine,
        fn.exported ? 1 : 0,
      ] as const;
      return fn.id === derivedIds[position] ? row : [...row, fn.id];
    });
    const file: WireFile =
      node.label === baseName(node.filePath)
        ? [node.filePath, wireFunctions]
        : [node.filePath, wireFunctions, node.label];
    fileChunks.at(-1)?.push(file);
  }

  const edgeChunks: number[][] = [[]];
  for (const edge of snapshot.edges) {
    const source = indexById.get(edge.source);
    const target = indexById.get(edge.target);
    if (source === undefined || target === undefined) {
      continue; // Dangling edge: it could not be rendered anyway.
    }
    let current = edgeChunks.at(-1) ?? [];
    if (current.length >= limits.maxEdges * EDGE_STRIDE) {
      current = [];
      edgeChunks.push(current);
    }
    current.push(EDGE_KINDS.indexOf(edge.kind), source, target, edge.line ?? 0);
  }

  const chunkCount = Math.max(fileChunks.length, edgeChunks.length);
  return Array.from({ length: chunkCount }, (_, index) => ({
    files: fileChunks[index] ?? [],
    edges: edgeChunks[index] ?? [],
  }));
}

/**
 * Rebuilds a snapshot from its chunks.
 *
 * @param version - Version of the snapshot.
 * @param chunks - Every chunk, in order.
 * @returns The decoded snapshot (structurally equal to the encoded one).
 */
export function decodeSnapshot(version: number, chunks: readonly WireGraphChunk[]): GraphSnapshot {
  const nodes: GraphNode[] = [];
  for (const chunk of chunks) {
    for (const [filePath, wireFunctions, label] of chunk.files) {
      const fileId = createFileId(filePath);
      const derivedIds = deriveFunctionIds(
        filePath,
        wireFunctions.map((fn) => fn[0]),
      );
      const functions = wireFunctions.map(
        ([qualifiedName, kind, line, endLine, exported, id], position): FunctionGraphNode => ({
          id: id ?? derivedIds[position] ?? qualifiedName,
          kind: 'function',
          label: qualifiedName,
          filePath,
          line,
          fileId,
          qualifiedName,
          functionKind: FUNCTION_KINDS[kind] ?? 'function',
          endLine,
          exported: exported === 1,
        }),
      );
      const file: FileGraphNode = {
        id: fileId,
        kind: 'file',
        label: label ?? baseName(filePath),
        filePath,
        line: 1,
        functionIds: functions.map((fn) => fn.id),
      };
      nodes.push(file, ...functions);
    }
  }

  const edges: GraphEdge[] = [];
  for (const chunk of chunks) {
    for (let offset = 0; offset + EDGE_STRIDE <= chunk.edges.length; offset += EDGE_STRIDE) {
      const kind = EDGE_KINDS[chunk.edges[offset] ?? 0] ?? 'import';
      const source = nodes[chunk.edges[offset + 1] ?? -1]?.id;
      const target = nodes[chunk.edges[offset + 2] ?? -1]?.id;
      const line = chunk.edges[offset + 3] ?? 0;
      if (source === undefined || target === undefined) {
        continue;
      }
      edges.push({
        id: createEdgeId(kind, source, target),
        kind,
        source,
        target,
        ...(line > 0 ? { line } : {}),
      });
    }
  }
  return { version, nodes, edges };
}
