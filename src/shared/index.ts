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
  FunctionDetails,
  FolderViewMode,
  GraphInitMessage,
  HostToWebview,
  MetricSample,
  ScrollBehavior,
  ViewOptions,
  WebviewToHost,
} from './messages';
export {
  COLLAPSE_MODES,
  FOLDER_VIEW_MODES,
  SCROLL_BEHAVIORS,
  MAX_DETAILS_TEXT,
  MAX_METRIC_SAMPLES,
  MAX_WORKSPACE_ROOTS,
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
export type {
  MiniEmptyReason,
  MiniGraph,
  MiniHostToView,
  MiniMode,
  MiniNode,
  MiniRelation,
  MiniViewToHost,
} from './miniMessages';
export { MINI_MODES, isMiniHostToViewMessage, isMiniViewToHostMessage } from './miniMessages';
export type {
  ReviewFile,
  ReviewFileStatus,
  ReviewFunction,
  ReviewMode,
  ReviewProblem,
  ReviewResult,
  ReviewState,
} from './review';
export { MAX_REVIEW_FILES, REVIEW_MODES, changedNodeIds, isReviewState } from './review';
