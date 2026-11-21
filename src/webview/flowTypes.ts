/**
 * React Flow node and edge types used by the CodeGraph canvas.
 */
import type { Edge, Node } from '@xyflow/react';

import type { EdgeKind, FunctionKind, RelPath } from '../shared';

/** Data carried by every node; enough to navigate to the source. */
interface NavigableNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly filePath: RelPath;
  /** 1-based line to reveal when the node is clicked. */
  readonly line: number;
}

/** Data of a file container node. */
export interface FileNodeData extends NavigableNodeData {
  readonly functionCount: number;
  /** Whether the file's functions are hidden. */
  readonly collapsed: boolean;
}

/** Data of a function node. */
export interface FunctionNodeData extends NavigableNodeData {
  readonly functionKind: FunctionKind;
  readonly exported: boolean;
}

/** Data of a folder container node. */
export interface FolderNodeData extends Record<string, unknown> {
  /** Displayed name (compacted chains such as `src/extension`). */
  readonly label: string;
  /** Workspace-relative folder path. */
  readonly path: RelPath;
  /** Number of files in the folder and its sub-folders. */
  readonly fileCount: number;
  /** Whether the folder's content is hidden. */
  readonly collapsed: boolean;
}

/** Folder container node: holds sub-folders and files. */
export type FolderFlowNode = Node<FolderNodeData, 'folder'>;

/** File container node. */
export type FileFlowNode = Node<FileNodeData, 'file'>;

/** Function node, rendered inside its file node. */
export type FunctionFlowNode = Node<FunctionNodeData, 'function'>;

/** Any node of the canvas. */
export type CodeGraphFlowNode = FolderFlowNode | FileFlowNode | FunctionFlowNode;

/** Data carried by every edge. */
export interface CodeGraphEdgeData extends Record<string, unknown> {
  readonly kind: EdgeKind;
  /** Number of model edges merged into this edge (more than 1 when files or folders are collapsed). */
  readonly count: number;
}

/** Any edge of the canvas. */
export type CodeGraphFlowEdge = Edge<CodeGraphEdgeData>;

/** Nodes and edges ready to render. */
export interface FlowElements {
  readonly nodes: CodeGraphFlowNode[];
  readonly edges: CodeGraphFlowEdge[];
}
