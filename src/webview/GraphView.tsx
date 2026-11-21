import type { FitViewOptions, NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AnalysisState, GraphSnapshot, RelPath } from '../shared';
import { getAllFileIds, getInitialCollapsedFileIds, toggleId } from './collapse';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import { GraphActionsContext } from './graphActions';
import type { GraphActions } from './graphActions';
import { GraphCanvas } from './GraphCanvas';
import type { GraphChange } from './graphChannel';
import { summarizeGraph } from './graphChannel';
import { addClassToNodes } from './patch';
import { SearchBox } from './SearchBox';
import { decorateEdges, decorateNodes, matchNodes } from './search';
import { StatusBar } from './StatusBar';
import type { ViewLayoutState } from './viewLayout';
import { computeViewLayout, isViewLayoutCurrent } from './viewLayout';

/** Props of {@link GraphView}. */
interface GraphViewProps {
  /** Graph to render; updated in place by live patches. */
  readonly snapshot: GraphSnapshot;
  /** Nodes touched by the latest patch, highlighted briefly. */
  readonly lastChange: GraphChange | null;
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

/** Shared empty set used when no node is highlighted. */
const NO_IDS: ReadonlySet<string> = new Set();

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
  status,
  errorMessage,
  onRefresh,
  onNavigate,
}: GraphViewProps): JSX.Element {
  const { fitView, getZoom } = useReactFlow<CodeGraphFlowNode, CodeGraphFlowEdge>();
  const [collapsedFileIds, setCollapsedFileIds] = useState(() =>
    getInitialCollapsedFileIds(snapshot),
  );
  const [layoutRequest, setLayoutRequest] = useState(0);
  const [query, setQuery] = useState('');
  const [expiredChangeVersion, setExpiredChangeVersion] = useState(0);
  /** Viewport fit to perform once the next layout has been rendered. */
  const pendingFitRef = useRef<FitViewOptions<CodeGraphFlowNode> | null>(null);

  // Recompute the canvas when its inputs change (adjusting state during render):
  // live patches keep file positions; collapse changes and re-layout do not.
  const [layoutState, setLayoutState] = useState<ViewLayoutState>(() =>
    computeViewLayout(null, snapshot, collapsedFileIds, layoutRequest),
  );
  let current = layoutState;
  if (!isViewLayoutCurrent(layoutState, snapshot, collapsedFileIds, layoutRequest)) {
    current = computeViewLayout(layoutState, snapshot, collapsedFileIds, layoutRequest);
    setLayoutState(current);
  }

  const highlightedChangeIds =
    lastChange !== null && lastChange.version > expiredChangeVersion ? lastChange.nodeIds : NO_IDS;

  const search = useMemo(() => matchNodes(snapshot, query), [snapshot, query]);
  const displayedNodes = useMemo(
    () => addClassToNodes(decorateNodes(current.nodes, search), highlightedChangeIds, 'cg-changed'),
    [current.nodes, search, highlightedChangeIds],
  );
  const displayedEdges = useMemo(
    () => decorateEdges(current.edges, search),
    [current.edges, search],
  );
  const summary = useMemo(() => summarizeGraph(snapshot), [snapshot]);

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
    if (search === null) {
      return;
    }
    const visibleIds = new Set(current.nodes.map((node) => node.id));
    const targets = [...search.highlightedIds].filter((id) => visibleIds.has(id));
    if (targets.length > 0) {
      void fitView({
        nodes: targets.map((id) => ({ id })),
        duration: VIEWPORT_ANIMATION_MS,
        maxZoom: SEARCH_MAX_ZOOM,
      });
    }
  }, [search, current.nodes, fitView]);

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
      </StatusBar>
      <main className="cg-canvas">
        <GraphCanvas
          nodes={displayedNodes}
          edges={displayedEdges}
          onNodesChange={onNodesChange}
          onNodeClick={handleNodeClick}
        />
      </main>
    </GraphActionsContext>
  );
}
