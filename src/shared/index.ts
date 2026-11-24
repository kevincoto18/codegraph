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
export type {
  AnalysisState,
  CollapseMode,
  FolderViewMode,
  GraphInitMessage,
  HostToWebview,
  MetricSample,
  ViewOptions,
  WebviewToHost,
} from './messages';
export {
  COLLAPSE_MODES,
  FOLDER_VIEW_MODES,
  MAX_METRIC_SAMPLES,
  createGraphInitMessages,
  isHostToWebviewMessage,
  isWebviewToHostMessage,
} from './messages';
export type { ConnectionFilters, NodeFilters, ViewPreferences } from './preferences';
export {
  DEFAULT_VIEW_PREFERENCES,
  MAX_EXCLUDE_PATTERNS,
  MAX_HIDDEN_FOLDERS,
  isViewPreferences,
  readViewPreferences,
} from './preferences';
export type { ChunkLimits, WireFile, WireFunction, WireGraphChunk } from './wire';
export { DEFAULT_CHUNK_LIMITS, decodeSnapshot, encodeSnapshot } from './wire';
export { createEdgeId, createFileId, createFunctionId, toPosixPath } from './ids';
