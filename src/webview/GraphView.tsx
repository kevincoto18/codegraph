import type { FitViewOptions, NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AnalysisState, GraphSnapshot, RelPath } from '../shared';
import { getAllFileIds, getInitialCollapsedFileIds, toggleId } from './collapse';
import type { CodeGraphFlowEdge, CodeGraphFlowNode, FlowElements } from './flowTypes';
import { GraphActionsContext } from './graphActions';
import type { GraphActions } from './graphActions';
import { GraphCanvas } from './GraphCanvas';
import { summarizeGraph } from './graphChannel';
import { buildFlowGraph } from './layout';
import { SearchBox } from './SearchBox';
import { decorateEdges, decorateNodes, matchNodes } from './search';
import { StatusBar } from './StatusBar';

/** Props of {@link GraphView}. */
interface GraphViewProps {
  /** Graph to render. Remount the view (via `key`) to load a new snapshot. */
  readonly snapshot: GraphSnapshot;
  readonly status: AnalysisState;
  readonly errorMessage: string | null;
  /** Requests a full rescan. */
  readonly onRefresh: () => void;
  /** Opens a file at a 1-based line. */
  readonly onNavigate: (filePath: RelPath, line: number) => void;
}

/** Nodes owned by the canvas, tied to the layout they were derived from. */
interface NodeState {
  readonly layout: FlowElements;
  readonly nodes: CodeGraphFlowNode[];
}

/** Duration of viewport animations, in milliseconds. */
const VIEWPORT_ANIMATION_MS = 300;

/** Highest zoom used when zooming to search matches. */
const SEARCH_MAX_ZOOM = 1.5;

/**
 * Graph screen: toolbar (status, search, expand/collapse all, refresh) and
 * the interactive canvas.
 *
 * @param props - Snapshot, status and host callbacks.
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
 * @param props - Snapshot, status and host callbacks.
 * @returns The toolbar and canvas.
 */
function GraphViewContent({
  snapshot,
  status,
  errorMessage,
  onRefresh,
  onNavigate,
}: GraphViewProps): JSX.Element {
  const { fitView, getZoom } = useReactFlow<CodeGraphFlowNode, CodeGraphFlowEdge>();
  const [collapsedFileIds, setCollapsedFileIds] = useState(() =>
    getInitialCollapsedFileIds(snapshot),
  );
  const [query, setQuery] = useState('');
  /** Viewport fit to perform once the next layout has been rendered. */
  const pendingFitRef = useRef<FitViewOptions<CodeGraphFlowNode> | null>(null);

  const layout = useMemo(
    () => buildFlowGraph(snapshot, { collapsedFileIds }),
    [snapshot, collapsedFileIds],
  );

  // A new layout replaces dragged positions (adjusting state during render).
  const [nodeState, setNodeState] = useState<NodeState>({ layout, nodes: layout.nodes });
  if (nodeState.layout !== layout) {
    setNodeState({ layout, nodes: layout.nodes });
  }
  const nodes = nodeState.layout === layout ? nodeState.nodes : layout.nodes;

  const search = useMemo(() => matchNodes(snapshot, query), [snapshot, query]);
  const displayedNodes = useMemo(() => decorateNodes(nodes, search), [nodes, search]);
  const displayedEdges = useMemo(() => decorateEdges(layout.edges, search), [layout.edges, search]);
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
  }, [layout, fitView]);

  const onNodesChange = useCallback<OnNodesChange<CodeGraphFlowNode>>((changes) => {
    setNodeState((state) => ({ ...state, nodes: changes.applyTo(state.nodes) }));
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

  const zoomToMatches = useCallback(() => {
    if (search === null) {
      return;
    }
    const visibleIds = new Set(nodes.map((node) => node.id));
    const targets = [...search.highlightedIds].filter((id) => visibleIds.has(id));
    if (targets.length > 0) {
      void fitView({
        nodes: targets.map((id) => ({ id })),
        duration: VIEWPORT_ANIMATION_MS,
        maxZoom: SEARCH_MAX_ZOOM,
      });
    }
  }, [search, nodes, fitView]);

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
