/**
 * Graph data model shared by the extension host and the webview.
 *
 * @remarks This module must stay environment-agnostic: no imports from
 * `vscode`, `node:*` or the DOM. All structures are immutable so snapshots and
 * patches can be diffed and applied predictably.
 */

/** Kind of a graph node. */
export type NodeKind = 'file' | 'function';

/** Syntactic form of a function declaration. */
export type FunctionKind = 'function' | 'arrow' | 'method';

/** Kind of relationship represented by an edge. */
export type EdgeKind = 'import' | 'call';

/**
 * Workspace-relative path in POSIX format (e.g. `src/utils/math.ts`).
 *
 * @remarks Absolute or OS-specific paths never enter the model; the extension
 * host converts a `RelPath` into a `vscode.Uri` only when it needs one.
 */
export type RelPath = string;

/** Properties common to every node in the graph. */
interface BaseGraphNode {
  /** Stable identifier (see `ids.ts`). */
  readonly id: string;
  /** Discriminant of the node union. */
  readonly kind: NodeKind;
  /** Short human-readable name shown in the UI. */
  readonly label: string;
  /** File that contains (or is) this node. */
  readonly filePath: RelPath;
  /** 1-based line where the node starts. */
  readonly line: number;
}

/** A source file of the workspace; acts as a container of functions. */
export interface FileGraphNode extends BaseGraphNode {
  readonly kind: 'file';
  /** Ids of the functions declared in this file, in source order. */
  readonly functionIds: readonly string[];
}

/** A function, arrow function assigned to a variable, or class method. */
export interface FunctionGraphNode extends BaseGraphNode {
  readonly kind: 'function';
  /** Id of the file node that contains this function. */
  readonly fileId: string;
  /** Name including its container, e.g. `UserService.save` or `formatDate`. */
  readonly qualifiedName: string;
  /** Syntactic form of the declaration. */
  readonly functionKind: FunctionKind;
  /** 1-based line where the function body ends. */
  readonly endLine: number;
  /** Whether the function is reachable from other files via `export`. */
  readonly exported: boolean;
}

/** Any node of the graph. */
export type GraphNode = FileGraphNode | FunctionGraphNode;

/** Directed relationship between two nodes. */
export interface GraphEdge {
  /** Stable identifier (see `ids.ts`). */
  readonly id: string;
  /** Relationship type. */
  readonly kind: EdgeKind;
  /** Id of the origin node (importer file or caller function). */
  readonly source: string;
  /** Id of the destination node (imported file or callee function). */
  readonly target: string;
  /** 1-based line of the import statement or call site in the source file. */
  readonly line?: number;
}

/** Complete state of the graph at a given version. */
export interface GraphSnapshot {
  /** Monotonically increasing version number. */
  readonly version: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/**
 * Incremental change between two consecutive snapshots.
 *
 * @remarks Receivers must ignore patches whose `version` is not greater than
 * the version they currently hold.
 */
export interface GraphPatch {
  /** Version of the snapshot this patch produces. */
  readonly version: number;
  /** Nodes added or modified (replaced by id). */
  readonly upsertNodes: readonly GraphNode[];
  /** Ids of nodes removed. */
  readonly removeNodeIds: readonly string[];
  /** Edges added or modified (replaced by id). */
  readonly upsertEdges: readonly GraphEdge[];
  /** Ids of edges removed. */
  readonly removeEdgeIds: readonly string[];
}
