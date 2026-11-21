/**
 * Public entry point of the shared contracts between the extension host and
 * the webview.
 */
export type {
  EdgeKind,
  FileGraphNode,
  FunctionGraphNode,
  FunctionKind,
  GraphEdge,
  GraphNode,
  GraphPatch,
  GraphSnapshot,
  NodeKind,
  RelPath,
} from './types';
export type { AnalysisState, HostToWebview, WebviewToHost } from './messages';
export { isHostToWebviewMessage, isWebviewToHostMessage } from './messages';
export { createEdgeId, createFileId, createFunctionId, toPosixPath } from './ids';
