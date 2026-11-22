import type { FitViewOptions, NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AnalysisState,
  CollapseMode,
  FolderViewMode,
  GraphSnapshot,
  RelPath,
} from '../shared';
import {
  EXPAND_ALL_NODE_BUDGET,
  getAllContainerIds,
  getIdsToReveal,
  getInitialCollapsedIds,
  getNextLevelToExpand,
  planExpandAll,
  toggleId,
} from './collapse';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import { GraphActionsContext } from './graphActions';
import type { GraphActions } from './graphActions';
import { GraphCanvas } from './GraphCanvas';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuAction, ContextMenuState, ContextMenuTarget } from './contextMenu';
import { getContextMenuItems } from './contextMenu';
import type { FocusRequest, GraphChange } from './graphChannel';
import { summarizeGraph } from './graphChannel';
import { reportMetric } from './metrics';
import type { MinimapPreference } from './canvasOptions';
import { shouldShowMinimap } from './canvasOptions';
import { ClassNameDecorator, joinClassNames } from './decorate';
import type { EdgeFilters } from './edgeFilters';
import { DEFAULT_EDGE_FILTERS, filterEdges } from './edgeFilters';
import type { FocusDirection } from './focus';
import { computeFocus, getFocusIdsToReveal, getFocusedDisplayIds } from './focus';
import type { FolderTree } from './folders';
import { buildFolderTree, isFolderViewEnabled } from './folders';
import { matchNodes, searchClassOfEdge, searchClassOfNode, withFolderContext } from './search';
import { Legend } from './Legend';
import { SettingsPanel } from './SettingsPanel';
import { StatusBar } from './StatusBar';
import { listFolderColors } from './folderColors';
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
  /** Focus asked by the host and not applied yet. */
  readonly focusRequest: FocusRequest | null;
  /** Called once a host focus request has been applied. */
  readonly onFocusHandled: (sequence: number) => void;
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

/** How long a notice stays on screen, in milliseconds. */
const NOTICE_MS = 6000;

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
  focusRequest,
  onFocusHandled,
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
  const [notice, setNotice] = useState<string | null>(null);
  const [folderColorsEnabled, setFolderColorsEnabled] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState(1);
  const [focusDirection, setFocusDirection] = useState<FocusDirection>('both');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
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
  const focus = useMemo(
    () =>
      focusId === null
        ? null
        : computeFocus(snapshot, focusId, {
            depth: focusDepth,
            direction: focusDirection,
            imports: edgeFilters.imports,
            calls: edgeFilters.calls,
          }),
    [snapshot, focusId, focusDepth, focusDirection, edgeFilters.imports, edgeFilters.calls],
  );
  const focusedIds = useMemo(
    () => (focus === null ? null : getFocusedDisplayIds(current.nodes, focus, folderTree)),
    [focus, current.nodes, folderTree],
  );
  const displayedNodes = useMemo(
    () =>
      nodeDecorator.apply(current.nodes, (node) =>
        joinClassNames(
          searchClassOfNode(node.id, search),
          highlightedChangeIds.has(node.id) ? 'cg-changed' : undefined,
          focusedIds === null || focusedIds.has(node.id) ? undefined : 'cg-focus-dimmed',
          node.id === focusId ? 'cg-focus-target' : undefined,
        ),
      ),
    [nodeDecorator, current.nodes, search, highlightedChangeIds, focusedIds, focusId],
  );
  const visibleEdges = useMemo(
    () => filterEdges(current.edges, current.nodes, edgeFilters),
    [current.edges, current.nodes, edgeFilters],
  );
  const displayedEdges = useMemo(
    () =>
      edgeDecorator.apply(visibleEdges, (edge) =>
        joinClassNames(
          searchClassOfEdge(edge, search),
          focusedIds === null || (focusedIds.has(edge.source) && focusedIds.has(edge.target))
            ? undefined
            : 'cg-focus-dimmed',
        ),
      ),
    [edgeDecorator, visibleEdges, search, focusedIds],
  );
  const showMinimap = shouldShowMinimap(minimapPreference, displayedNodes.length);
  const summary = useMemo(() => summarizeGraph(snapshot), [snapshot]);
  const folderColorEntries = useMemo(
    () =>
      listFolderColors(
        snapshot.nodes.filter((node) => node.kind === 'file').map((node) => node.filePath),
      ),
    [snapshot],
  );

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
    const plan = planExpandAll(snapshot, folderTree, collapsedIds);
    pendingFitRef.current = { duration: VIEWPORT_ANIMATION_MS };
    setCollapsedIds(plan.collapsedIds);
    setNotice(
      plan.complete
        ? null
        : `Opened as much as fits in ${EXPAND_ALL_NODE_BUDGET.toLocaleString('en-US')} nodes. Open the remaining folders or files one by one.`,
    );
  }, [snapshot, folderTree, collapsedIds]);

  useEffect(() => {
    if (notice === null) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setNotice(null);
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

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

  const enterFocus = useCallback(
    (nodeId: string, direction: FocusDirection = focusDirection) => {
      const neighborhood = computeFocus(snapshot, nodeId, {
        depth: focusDepth,
        direction,
        imports: edgeFilters.imports,
        calls: edgeFilters.calls,
      });
      if (neighborhood.nodeIds.size === 0) {
        return;
      }
      setFocusId(nodeId);
      setFocusDirection(direction);
      const fit: FitViewOptions<CodeGraphFlowNode> = {
        nodes: [...neighborhood.nodeIds].map((id) => ({ id })),
        duration: VIEWPORT_ANIMATION_MS,
        maxZoom: 1,
      };
      // Open what hides the focused node and its neighbors, then fit.
      const toExpand = [...getFocusIdsToReveal(snapshot, neighborhood, folderTree)].filter((id) =>
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
    },
    [snapshot, focusDepth, focusDirection, edgeFilters, folderTree, collapsedIds, fitView],
  );

  const exitFocus = useCallback(() => {
    setFocusId(null);
  }, []);

  const focusSelected = useCallback(() => {
    const selected = current.nodes.find((node) => node.selected === true && node.type !== 'folder');
    if (selected !== undefined) {
      enterFocus(selected.id);
    }
  }, [current.nodes, enterFocus]);

  // While focusing, clicking another file or function moves the focus to it.
  const handleNodeClick = useCallback<NodeMouseHandler<CodeGraphFlowNode>>(
    (_event, node) => {
      if (node.type === 'folder') {
        toggle(node.id);
        return;
      }
      if (focusId !== null && node.id !== focusId) {
        enterFocus(node.id);
      }
      onNavigate(node.data.filePath, node.data.line);
    },
    [onNavigate, toggle, focusId, enterFocus],
  );

  const handleNodeContextMenu = useCallback<NodeMouseHandler<CodeGraphFlowNode>>(
    (event, node) => {
      event.preventDefault();
      const target: ContextMenuTarget =
        node.type === 'folder'
          ? { kind: 'folder', nodeId: node.id }
          : { kind: 'node', nodeId: node.id, nodeType: node.type };
      const items = getContextMenuItems(target, focusId !== null);
      setContextMenu(items.length === 0 ? null : { x: event.clientX, y: event.clientY, items });
    },
    [focusId],
  );

  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      event.preventDefault();
      const items = getContextMenuItems({ kind: 'pane' }, focusId !== null);
      setContextMenu(items.length === 0 ? null : { x: event.clientX, y: event.clientY, items });
    },
    [focusId],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const runContextMenuAction = useCallback(
    (action: ContextMenuAction) => {
      setContextMenu(null);
      switch (action.type) {
        case 'focus':
          enterFocus(action.nodeId, action.direction);
          break;
        case 'navigate': {
          const node = snapshot.nodes.find((item) => item.id === action.nodeId);
          if (node !== undefined) {
            onNavigate(node.filePath, node.line);
          }
          break;
        }
        case 'toggleFolder':
          toggle(action.nodeId);
          break;
        case 'exitFocus':
          setFocusId(null);
          break;
      }
    },
    [enterFocus, snapshot, onNavigate, toggle],
  );

  const handleNodeDoubleClick = useCallback<NodeMouseHandler<CodeGraphFlowNode>>(
    (_event, node) => {
      if (node.type !== 'folder') {
        enterFocus(node.id);
      }
    },
    [enterFocus],
  );

  // Apply a focus asked by the host ("Show Connections").
  useEffect(() => {
    if (focusRequest === null) {
      return;
    }
    onFocusHandled(focusRequest.sequence);
    // The request comes from the extension host (an external system) and is applied once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    enterFocus(focusRequest.nodeId);
  }, [focusRequest, onFocusHandled, enterFocus]);

  // Escape leaves focus mode (unless typing in a field).
  useEffect(() => {
    if (focusId === null) {
      return undefined;
    }
    /**
     * Exits focus mode on Escape.
     *
     * @param event - Keyboard event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape' && target?.tagName !== 'INPUT') {
        setFocusId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [focusId]);

  const focusLabel = useMemo(() => {
    const node = focusId === null ? undefined : snapshot.nodes.find((item) => item.id === focusId);
    return node === undefined
      ? null
      : node.kind === 'file'
        ? node.filePath
        : `${node.label} · ${node.filePath}`;
  }, [focusId, snapshot]);

  const toggleEdgeFilter = useCallback((key: keyof EdgeFilters) => {
    setEdgeFilters((filters) => ({ ...filters, [key]: !filters[key] }));
  }, []);

  const toggleFolderColors = useCallback(() => {
    setFolderColorsEnabled((enabled) => !enabled);
  }, []);

  const toggleMinimap = useCallback(() => {
    setMinimapPreference(showMinimap ? 'off' : 'on');
  }, [showMinimap]);

  const actions = useMemo<GraphActions>(() => ({ toggle }), [toggle]);

  const panel = (
    <SettingsPanel
      query={query}
      matchCount={search === null ? null : search.matchedIds.size}
      onQueryChange={setQuery}
      onSearchSubmit={zoomToMatches}
      edgeFilters={edgeFilters}
      onToggleEdgeFilter={toggleEdgeFilter}
      onExpandLevel={expandLevel}
      onExpandAll={expandAll}
      onCollapseAll={collapseAll}
      onRelayout={relayout}
      minimapShown={showMinimap}
      onToggleMinimap={toggleMinimap}
      folderColorsEnabled={folderColorsEnabled}
      onToggleFolderColors={toggleFolderColors}
      folderColors={folderColorEntries}
      focusLabel={focusLabel}
      focusDepth={focusDepth}
      focusDirection={focusDirection}
      onFocusSelected={focusSelected}
      onExitFocus={exitFocus}
      onFocusDepthChange={setFocusDepth}
      onFocusDirectionChange={setFocusDirection}
    />
  );

  return (
    <GraphActionsContext value={actions}>
      <StatusBar
        status={status}
        errorMessage={errorMessage}
        summary={summary}
        onRefresh={onRefresh}
      >
        <Legend />
      </StatusBar>
      <main className="cg-canvas">
        {notice !== null && (
          <div className="cg-notice" role="status">
            {notice}
          </div>
        )}
        <GraphCanvas
          nodes={displayedNodes}
          edges={displayedEdges}
          onNodesChange={onNodesChange}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeContextMenu={handleNodeContextMenu}
          onPaneContextMenu={handlePaneContextMenu}
          onMoveStart={closeContextMenu}
          showMinimap={showMinimap}
          folderColors={folderColorsEnabled}
          panel={panel}
        />
        {contextMenu !== null && (
          <ContextMenu
            menu={contextMenu}
            onSelect={runContextMenuAction}
            onClose={closeContextMenu}
          />
        )}
      </main>
    </GraphActionsContext>
  );
}
