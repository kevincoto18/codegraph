import type { FitViewOptions, NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AnalysisState,
  CollapseMode,
  FolderViewMode,
  GraphSnapshot,
  RelPath,
} from '../shared';
import {
  getAllContainerIds,
  getIdsToReveal,
  getInitialCollapsedIds,
  getNextLevelToExpand,
  toggleId,
} from './collapse';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import { GraphActionsContext } from './graphActions';
import type { GraphActions } from './graphActions';
import { GraphCanvas } from './GraphCanvas';
import type { GraphChange } from './graphChannel';
import { summarizeGraph } from './graphChannel';
import { reportMetric } from './metrics';
import type { MinimapPreference } from './canvasOptions';
import { shouldShowMinimap } from './canvasOptions';
import { ClassNameDecorator, joinClassNames } from './decorate';
import type { EdgeFilters } from './edgeFilters';
import { DEFAULT_EDGE_FILTERS, filterEdges } from './edgeFilters';
import { SearchBox } from './SearchBox';
import type { FolderTree } from './folders';
import { buildFolderTree, isFolderViewEnabled } from './folders';
import { matchNodes, searchClassOfEdge, searchClassOfNode, withFolderContext } from './search';
import { StatusBar } from './StatusBar';
import type { ViewLayoutInputs, ViewLayoutState } from './viewLayout';
import { computeViewLayout, isViewLayoutCurrent } from './viewLayout';
import { useDebouncedValue } from './useDebouncedValue';

/** Props of {@link GraphView}. */
interface GraphViewProps {
  /** Graph to render; updated in place by live patches. */
  readonly snapshot: GraphSnapshot;
  /** Nodes touched by the latest patch, highlighted briefly. */
  readonly lastChange: GraphChange | null;
  /** Initial collapse state of files; changing it resets the collapsed containers. */
  readonly collapseMode: CollapseMode;
  /** Whether files are grouped into folders; changing it resets the view. */
  readonly folderViewMode: FolderViewMode;
  readonly status: AnalysisState;
  readonly errorMessage: string | null;
  /** Requests a full rescan. */
  readonly onRefresh: () => void;
  /** Opens a file at a 1-based line. */
  readonly onNavigate: (filePath: RelPath, line: number) => void;
}

/** Duration of viewport animations, in milliseconds. */
const VIEWPORT_ANIMATION_MS = 300;

/** Highest zoom used when zooming to search matches. */
const SEARCH_MAX_ZOOM = 1.5;

/** How long changed nodes stay highlighted after a patch, in milliseconds. */
const CHANGE_HIGHLIGHT_MS = 1500;

/** Quiet period before a search query is applied, in milliseconds. */
const SEARCH_DEBOUNCE_MS = 150;

/** Most matches revealed (by expanding their folders and files) when pressing Enter. */
const MAX_REVEALED_MATCHES = 50;

/** Shared empty set used when no node is highlighted. */
const NO_IDS: ReadonlySet<string> = new Set();

/** Layout state plus how long it took to compute. */
type MeasuredLayout = ViewLayoutState & { readonly durationMs: number };

/**
 * Computes the canvas layout and times it.
 *
 * @param previous - Previous layout state, or `null` on first render.
 * @param inputs - Snapshot, collapsed containers, folder tree and re-layout counter.
 * @returns The new layout state with its computation time.
 */
function measureLayout(previous: ViewLayoutState | null, inputs: ViewLayoutInputs): MeasuredLayout {
  const startedAt = performance.now();
  const state = computeViewLayout(previous, inputs);
  return { ...state, durationMs: performance.now() - startedAt };
}

/**
 * Counts the files of a snapshot.
 *
 * @param snapshot - Graph snapshot.
 * @returns Number of file nodes.
 */
function countFiles(snapshot: GraphSnapshot): number {
  return snapshot.nodes.reduce((count, node) => count + (node.kind === 'file' ? 1 : 0), 0);
}

/**
 * Builds the folder tree when the folder view is on.
 *
 * @param snapshot - Graph snapshot.
 * @param folderView - Whether files are grouped into folders.
 * @returns The folder tree, or `null`.
 */
function folderTreeOf(snapshot: GraphSnapshot, folderView: boolean): FolderTree | null {
  return folderView ? buildFolderTree(snapshot.nodes) : null;
}

/**
 * Graph screen: toolbar (status, search, expand/collapse all, re-layout,
 * refresh) and the interactive canvas.
 *
 * @param props - Snapshot, latest change, status and host callbacks.
 * @returns The graph view element.
 */
export function GraphView(props: GraphViewProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <GraphViewContent {...props} />
    </ReactFlowProvider>
  );
}

/**
 * Stateful content of {@link GraphView}; must be rendered inside a
 * `ReactFlowProvider` to control the viewport.
 *
 * @param props - Snapshot, latest change, status and host callbacks.
 * @returns The toolbar and canvas.
 */
function GraphViewContent({
  snapshot,
  lastChange,
  collapseMode,
  folderViewMode,
  status,
  errorMessage,
  onRefresh,
  onNavigate,
}: GraphViewProps): JSX.Element {
  const { fitView, getZoom } = useReactFlow<CodeGraphFlowNode, CodeGraphFlowEdge>();
  // `auto` is decided once per graph, so live patches never switch the view.
  const [folderView, setFolderView] = useState(() =>
    isFolderViewEnabled(folderViewMode, countFiles(snapshot)),
  );
  const folderTree = useMemo(() => folderTreeOf(snapshot, folderView), [snapshot, folderView]);
  const [collapsedIds, setCollapsedIds] = useState(() =>
    getInitialCollapsedIds(snapshot, collapseMode, folderTree),
  );
  // New settings re-apply the initial view state.
  const [appliedModes, setAppliedModes] = useState({ collapseMode, folderViewMode });
  if (
    appliedModes.collapseMode !== collapseMode ||
    appliedModes.folderViewMode !== folderViewMode
  ) {
    const nextFolderView = isFolderViewEnabled(folderViewMode, countFiles(snapshot));
    setAppliedModes({ collapseMode, folderViewMode });
    setFolderView(nextFolderView);
    setCollapsedIds(
      getInitialCollapsedIds(snapshot, collapseMode, folderTreeOf(snapshot, nextFolderView)),
    );
  }
  const [layoutRequest, setLayoutRequest] = useState(0);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [minimapPreference, setMinimapPreference] = useState<MinimapPreference>('auto');
  const [edgeFilters, setEdgeFilters] = useState<EdgeFilters>(DEFAULT_EDGE_FILTERS);
  // Decorators reuse unchanged node/edge objects so React Flow skips re-rendering them.
  const [nodeDecorator] = useState(() => new ClassNameDecorator<CodeGraphFlowNode>());
  const [edgeDecorator] = useState(() => new ClassNameDecorator<CodeGraphFlowEdge>());
  const [expiredChangeVersion, setExpiredChangeVersion] = useState(0);
  /** Viewport fit to perform once the next layout has been rendered. */
  const pendingFitRef = useRef<FitViewOptions<CodeGraphFlowNode> | null>(null);

  // Recompute the canvas when its inputs change (adjusting state during render):
  // live patches keep file positions; collapse changes and re-layout do not.
  const layoutInputs: ViewLayoutInputs = { snapshot, collapsedIds, folderTree, layoutRequest };
  const [layoutState, setLayoutState] = useState<MeasuredLayout>(() =>
    measureLayout(null, layoutInputs),
  );
  let current = layoutState;
  if (!isViewLayoutCurrent(layoutState, layoutInputs)) {
    current = measureLayout(layoutState, layoutInputs);
    setLayoutState(current);
  }
  // Time from the first render until the graph is painted.
  const [mountedAt] = useState(() => performance.now());

  const highlightedChangeIds =
    lastChange !== null && lastChange.version > expiredChangeVersion ? lastChange.nodeIds : NO_IDS;

  const search = useMemo(
    () => withFolderContext(matchNodes(snapshot, debouncedQuery), folderTree),
    [snapshot, debouncedQuery, folderTree],
  );
  const displayedNodes = useMemo(
    () =>
      nodeDecorator.apply(current.nodes, (node) =>
        joinClassNames(
          searchClassOfNode(node.id, search),
          highlightedChangeIds.has(node.id) ? 'cg-changed' : undefined,
        ),
      ),
    [nodeDecorator, current.nodes, search, highlightedChangeIds],
  );
  const visibleEdges = useMemo(
    () => filterEdges(current.edges, current.nodes, edgeFilters),
    [current.edges, current.nodes, edgeFilters],
  );
  const displayedEdges = useMemo(
    () => edgeDecorator.apply(visibleEdges, (edge) => searchClassOfEdge(edge, search)),
    [edgeDecorator, visibleEdges, search],
  );
  const showMinimap = shouldShowMinimap(minimapPreference, displayedNodes.length);
  const summary = useMemo(() => summarizeGraph(snapshot), [snapshot]);

  // Report each recomputed layout once (dragging nodes does not recompute it).
  useEffect(() => {
    reportMetric(`layout.${current.mode}`, current.durationMs);
  }, [
    current.snapshot,
    current.collapsedIds,
    current.folderTree,
    current.layoutRequest,
    current.mode,
    current.durationMs,
  ]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      reportMetric('render.first', performance.now() - mountedAt);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [mountedAt]);

  useEffect(() => {
    const request = pendingFitRef.current;
    if (request === null) {
      return undefined;
    }
    pendingFitRef.current = null;
    // Wait one frame so React Flow has synced the new node positions.
    const frame = requestAnimationFrame(() => {
      void fitView(request);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [current, fitView]);

  useEffect(() => {
    if (lastChange === null || lastChange.version <= expiredChangeVersion) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setExpiredChangeVersion(lastChange.version);
    }, CHANGE_HIGHLIGHT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [lastChange, expiredChangeVersion]);

  const onNodesChange = useCallback<OnNodesChange<CodeGraphFlowNode>>((changes) => {
    setLayoutState((state) => ({ ...state, nodes: changes.applyTo(state.nodes) }));
  }, []);

  const toggle = useCallback(
    (containerId: string) => {
      // Keep the current zoom and re-center on the toggled container after relayout.
      const zoom = getZoom();
      pendingFitRef.current = {
        nodes: [{ id: containerId }],
        minZoom: zoom,
        maxZoom: zoom,
        duration: VIEWPORT_ANIMATION_MS,
      };
      setCollapsedIds((ids) => toggleId(ids, containerId));
    },
    [getZoom],
  );

  const handleNodeClick = useCallback<NodeMouseHandler<CodeGraphFlowNode>>(
    (_event, node) => {
      if (node.type === 'folder') {
        toggle(node.id);
      } else {
        onNavigate(node.data.filePath, node.data.line);
      }
    },
    [onNavigate, toggle],
  );

  const expandLevel = useCallback(() => {
    const ids = getNextLevelToExpand(current.nodes);
    if (ids.length === 0) {
      return;
    }
    pendingFitRef.current = { duration: VIEWPORT_ANIMATION_MS };
    setCollapsedIds((collapsed) => {
      const next = new Set(collapsed);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }, [current.nodes]);

  const expandAll = useCallback(() => {
    pendingFitRef.current = { duration: VIEWPORT_ANIMATION_MS };
    setCollapsedIds(new Set());
  }, []);

  const collapseAll = useCallback(() => {
    pendingFitRef.current = { duration: VIEWPORT_ANIMATION_MS };
    setCollapsedIds(getAllContainerIds(snapshot, folderTree));
  }, [snapshot, folderTree]);

  const relayout = useCallback(() => {
    pendingFitRef.current = { duration: VIEWPORT_ANIMATION_MS };
    setLayoutRequest((request) => request + 1);
  }, []);

  const zoomToMatches = useCallback(() => {
    // Match the latest query directly: Enter may arrive before the debounce settles.
    const latest = matchNodes(snapshot, query);
    if (latest === null || latest.matchedIds.size === 0) {
      return;
    }
    const targets = [...latest.matchedIds].slice(0, MAX_REVEALED_MATCHES);
    const fit: FitViewOptions<CodeGraphFlowNode> = {
      nodes: targets.map((id) => ({ id })),
      duration: VIEWPORT_ANIMATION_MS,
      maxZoom: SEARCH_MAX_ZOOM,
    };
    // Open the folders and files that hide the matches, then fit once laid out.
    const toExpand = [...getIdsToReveal(snapshot, folderTree, targets)].filter((id) =>
      collapsedIds.has(id),
    );
    if (toExpand.length > 0) {
      pendingFitRef.current = fit;
      setCollapsedIds((collapsed) => {
        const next = new Set(collapsed);
        toExpand.forEach((id) => next.delete(id));
        return next;
      });
      return;
    }
    void fitView(fit);
  }, [snapshot, query, folderTree, collapsedIds, fitView]);

  const toggleEdgeFilter = useCallback((key: keyof EdgeFilters) => {
    setEdgeFilters((filters) => ({ ...filters, [key]: !filters[key] }));
  }, []);

  const toggleMinimap = useCallback(() => {
    setMinimapPreference(showMinimap ? 'off' : 'on');
  }, [showMinimap]);

  const actions = useMemo<GraphActions>(() => ({ toggle }), [toggle]);

  return (
    <GraphActionsContext value={actions}>
      <StatusBar
        status={status}
        errorMessage={errorMessage}
        summary={summary}
        onRefresh={onRefresh}
      >
        <SearchBox
          value={query}
          matchCount={search === null ? null : search.matchedIds.size}
          onChange={setQuery}
          onSubmit={zoomToMatches}
        />
        <button
          type="button"
          className="cg-toolbar__button"
          onClick={expandLevel}
          title="Open the next level: collapsed folders, or files when no folder is collapsed"
        >
          Expand level
        </button>
        <button type="button" className="cg-toolbar__button" onClick={expandAll}>
          Expand all
        </button>
        <button type="button" className="cg-toolbar__button" onClick={collapseAll}>
          Collapse all
        </button>
        <button
          type="button"
          className="cg-toolbar__button"
          onClick={relayout}
          title="Recompute the layout of every file"
        >
          Re-layout
        </button>
        <div className="cg-toolbar__group" role="group" aria-label="Connections to show">
          Show:
          <button
            type="button"
            className="cg-toolbar__button"
            aria-pressed={edgeFilters.imports}
            onClick={() => {
              toggleEdgeFilter('imports');
            }}
            title="Imports between files (dashed purple lines)"
          >
            Imports
          </button>
          <button
            type="button"
            className="cg-toolbar__button"
            aria-pressed={edgeFilters.calls}
            onClick={() => {
              toggleEdgeFilter('calls');
            }}
            title="Calls between functions (solid blue lines)"
          >
            Calls
          </button>
          <button
            type="button"
            className="cg-toolbar__button"
            aria-pressed={edgeFilters.calls && edgeFilters.internalCalls}
            disabled={!edgeFilters.calls}
            onClick={() => {
              toggleEdgeFilter('internalCalls');
            }}
            title="Calls between functions of the same file"
          >
            Internal calls
          </button>
        </div>
        <button
          type="button"
          className="cg-toolbar__button"
          onClick={toggleMinimap}
          aria-pressed={showMinimap}
          title="Show or hide the minimap (hidden automatically on large graphs)"
        >
          Minimap
        </button>
      </StatusBar>
      <main className="cg-canvas">
        <GraphCanvas
          nodes={displayedNodes}
          edges={displayedEdges}
          onNodesChange={onNodesChange}
          onNodeClick={handleNodeClick}
          showMinimap={showMinimap}
        />
      </main>
    </GraphActionsContext>
  );
}
