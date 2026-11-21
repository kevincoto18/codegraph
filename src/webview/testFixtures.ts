/**
 * Builders of graph model elements shared by webview unit tests.
 */
import type { FileGraphNode, FunctionGraphNode, GraphEdge, GraphPatch } from '../shared';

/**
 * Creates a file node.
 *
 * @param id - File path used as id.
 * @param functionIds - Ids of the functions it declares.
 * @returns The file node.
 */
export function fileNode(id: string, functionIds: string[] = []): FileGraphNode {
  return { id, kind: 'file', label: id, filePath: id, line: 1, functionIds };
}

/**
 * Creates a function node.
 *
 * @param fileId - Containing file.
 * @param name - Qualified name.
 * @param line - 1-based start line.
 * @param overrides - Properties to override.
 * @returns The function node.
 */
export function functionNode(
  fileId: string,
  name: string,
  line = 1,
  overrides: Partial<FunctionGraphNode> = {},
): FunctionGraphNode {
  return {
    id: `${fileId}#${name}`,
    kind: 'function',
    label: name,
    filePath: fileId,
    line,
    fileId,
    qualifiedName: name,
    functionKind: 'function',
    endLine: line,
    exported: false,
    ...overrides,
  };
}

/**
 * Creates a call edge.
 *
 * @param source - Caller id.
 * @param target - Callee id.
 * @returns The edge.
 */
export function callEdge(source: string, target: string): GraphEdge {
  return { id: `call:${source}->${target}`, kind: 'call', source, target };
}

/**
 * Creates a patch with defaults for omitted change lists.
 *
 * @param version - Patch version.
 * @param changes - Change lists to set.
 * @returns The patch.
 */
export function makePatch(
  version: number,
  changes: Partial<Omit<GraphPatch, 'version'>> = {},
): GraphPatch {
  return {
    version,
    upsertNodes: [],
    removeNodeIds: [],
    upsertEdges: [],
    removeEdgeIds: [],
    ...changes,
  };
}
