import type { FitViewOptions, NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AnalysisState, CollapseMode, GraphSnapshot, RelPath } from '../shared';
import { getAllFileIds, getInitialCollapsedFileIds, toggleId } from './collapse';
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
import { SearchBox } from './SearchBox';
import { matchNodes, searchClassOfEdge, searchClassOfNode } from './search';
import { StatusBar } from './StatusBar';
import type { ViewLayoutState } from './viewLayout';
import { computeViewLayout, isViewLayoutCurrent } from './viewLayout';
import { useDebouncedValue } from './useDebouncedValue';

/** Props of {@link GraphView}. */
interface GraphViewProps {
  /** Graph to render; updated in place by live patches. */
  readonly snapshot: GraphSnapshot;
  /** Nodes touched by the latest patch, highlighted briefly. */
  readonly lastChange: GraphChange | null;
  /** Initial collapse state of files; changing it resets the collapsed files. */
  readonly collapseMode: CollapseMode;
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

/** Shared empty set used when no node is highlighted. */
const NO_IDS: ReadonlySet<string> = new Set();

/** Layout state plus how long it took to compute. */
type MeasuredLayout = ViewLayoutState & { readonly durationMs: number };

/**
 * Computes the canvas layout and times it.
 *
 * @param previous - Previous layout state, or `null` on first render.
 * @param snapshot - Graph snapshot.
 * @param collapsedFileIds - Ids of collapsed files.
 * @param layoutRequest - Re-layout counter.
 * @returns The new layout state with its computation time.
 */
function measureLayout(
  previous: ViewLayoutState | null,
  snapshot: GraphSnapshot,
  collapsedFileIds: ReadonlySet<string>,
  layoutRequest: number,
): MeasuredLayout {
  const startedAt = performance.now();
  const state = computeViewLayout(previous, snapshot, collapsedFileIds, layoutRequest);
  return { ...state, durationMs: performance.now() - startedAt };
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
  status,
  errorMessage,
  onRefresh,
  onNavigate,
}: GraphViewProps): JSX.Element {
  const { fitView, getZoom } = useReactFlow<CodeGraphFlowNode, CodeGraphFlowEdge>();
  const [collapsedFileIds, setCollapsedFileIds] = useState(() =>
    getInitialCollapsedFileIds(snapshot, collapseMode),
  );
  // A new collapse setting re-applies the initial collapse state.
  const [appliedCollapseMode, setAppliedCollapseMode] = useState(collapseMode);
  if (appliedCollapseMode !== collapseMode) {
    setAppliedCollapseMode(collapseMode);
    setCollapsedFileIds(getInitialCollapsedFileIds(snapshot, collapseMode));
  }
  const [layoutRequest, setLayoutRequest] = useState(0);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [minimapPreference, setMinimapPreference] = useState<MinimapPreference>('auto');
  // Decorators reuse unchanged node/edge objects so React Flow skips re-rendering them.
  const [nodeDecorator] = useState(() => new ClassNameDecorator<CodeGraphFlowNode>());
  const [edgeDecorator] = useState(() => new ClassNameDecorator<CodeGraphFlowEdge>());
  const [expiredChangeVersion, setExpiredChangeVersion] = useState(0);
  /** Viewport fit to perform once the next layout has been rendered. */
  const pendingFitRef = useRef<FitViewOptions<CodeGraphFlowNode> | null>(null);

  // Recompute the canvas when its inputs change (adjusting state during render):
  // live patches keep file positions; collapse changes and re-layout do not.
  const [layoutState, setLayoutState] = useState<MeasuredLayout>(() =>
    measureLayout(null, snapshot, collapsedFileIds, layoutRequest),
  );
  let current = layoutState;
  if (!isViewLayoutCurrent(layoutState, snapshot, collapsedFileIds, layoutRequest)) {
    current = measureLayout(layoutState, snapshot, collapsedFileIds, layoutRequest);
    setLayoutState(current);
  }
  // Time from the first render until the graph is painted.
  const [mountedAt] = useState(() => performance.now());

  const highlightedChangeIds =
    lastChange !== null && lastChange.version > expiredChangeVersion ? lastChange.nodeIds : NO_IDS;

  const search = useMemo(() => matchNodes(snapshot, debouncedQuery), [snapshot, debouncedQuery]);
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
  const displayedEdges = useMemo(
    () => edgeDecorator.apply(current.edges, (edge) => searchClassOfEdge(edge, search)),
    [edgeDecorator, current.edges, search],
  );
  const showMinimap = shouldShowMinimap(minimapPreference, displayedNodes.length);
  const summary = useMemo(() => summarizeGraph(snapshot), [snapshot]);

  // Report each recomputed layout once (dragging nodes does not recompute it).
  useEffect(() => {
    reportMetric(`layout.${current.mode}`, current.durationMs);
  }, [
    current.snapshot,
    current.collapsedFileIds,
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

  const handleNodeClick = useCallback<NodeMouseHandler<CodeGraphFlowNode>>(
    (_event, node) => {
      onNavigate(node.data.filePath, node.data.line);
    },
    [onNavigate],
  );

  const toggleFile = useCallback(
    (fileId: string) => {
      // Keep the current zoom and re-center on the toggled file after relayout.
      const zoom = getZoom();
      pendingFitRef.current = {
        nodes: [{ id: fileId }],
        minZoom: zoom,
        maxZoom: zoom,
        duration: VIEWPORT_ANIMATION_MS,
      };
      setCollapsedFileIds((ids) => toggleId(ids, fileId));
    },
    [getZoom],
  );

  const expandAll = useCallback(() => {
    pendingFitRef.current = { duration: VIEWPORT_ANIMATION_MS };
    setCollapsedFileIds(new Set());
  }, []);

  const collapseAll = useCallback(() => {
    pendingFitRef.current = { duration: VIEWPORT_ANIMATION_MS };
    setCollapsedFileIds(getAllFileIds(snapshot));
  }, [snapshot]);

  const relayout = useCallback(() => {
    pendingFitRef.current = { duration: VIEWPORT_ANIMATION_MS };
    setLayoutRequest((request) => request + 1);
  }, []);

  const zoomToMatches = useCallback(() => {
    // Match the latest query directly: Enter may arrive before the debounce settles.
    const latest = matchNodes(snapshot, query);
    if (latest === null) {
      return;
    }
    const visibleIds = new Set(current.nodes.map((node) => node.id));
    const targets = [...latest.highlightedIds].filter((id) => visibleIds.has(id));
    if (targets.length > 0) {
      void fitView({
        nodes: targets.map((id) => ({ id })),
        duration: VIEWPORT_ANIMATION_MS,
        maxZoom: SEARCH_MAX_ZOOM,
      });
    }
  }, [snapshot, query, current.nodes, fitView]);

  const toggleMinimap = useCallback(() => {
    setMinimapPreference(showMinimap ? 'off' : 'on');
  }, [showMinimap]);

  const actions = useMemo<GraphActions>(() => ({ toggleFile }), [toggleFile]);

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
