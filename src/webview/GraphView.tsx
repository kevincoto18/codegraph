import type { FitViewOptions, NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AnalysisState,
  CollapseMode,
  FolderViewMode,
  ConnectionFilters,
  GraphSnapshot,
  NodeFilters,
  RelPath,
  ViewPreferences,
} from '../shared';
import {
  EXPAND_ALL_NODE_BUDGET,
  collapseNewContainers,
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
import type { ContextMenuAction, ContextMenuState, ContextMenuTarget } from './contextMenuItems';
import { getContextMenuItems } from './contextMenuItems';
import type { FocusRequest, GraphChange, RevealRequest } from './graphChannel';
import { summarizeGraph } from './graphChannel';
import { reportMetric } from './metrics';
import type { MinimapPreference } from './canvasOptions';
import { shouldShowMinimap } from './canvasOptions';
import { ClassNameDecorator, joinClassNames } from './decorate';
import { filterEdges } from './edgeFilters';
import type { FocusDirection } from './focus';
import { computeFocus, getFocusIdsToReveal, getFocusedDisplayIds } from './focus';
import type { FolderTree } from './folders';
import { buildFolderTree, isFolderViewEnabled } from './folders';
import { matchNodes, searchClassOfEdge, searchClassOfNode, withFolderContext } from './search';
import { Legend } from './Legend';
import { Icon } from './icons';
import { applyNodeFilters, listFolders } from './nodeFilters';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { assignFolderColors, listFolderColors } from './folderColors';
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
  /** Node under the editor cursor to highlight (editor sync), not applied yet. */
  readonly revealRequest: RevealRequest | null;
  /** Called once a reveal request has been applied. */
  readonly onRevealHandled: (sequence: number) => void;
  /** Filters and editor sync, persisted per workspace by the host. */
  readonly preferences: ViewPreferences;
  /** Called with new preferences when the user changes them. */
  readonly onPreferencesChange: (preferences: ViewPreferences) => void;
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

/** Lowest zoom used when centering the node under the editor cursor (keeps labels readable). */
const SYNC_MIN_ZOOM = 0.75;

/** Margin, in screen pixels, a node must keep from the viewport edge to count as visible. */
const SYNC_VISIBLE_MARGIN = 24;

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
  snapshot: fullSnapshot,
  lastChange,
  collapseMode,
  folderViewMode,
  focusRequest,
  onFocusHandled,
  revealRequest,
  onRevealHandled,
  preferences,
  onPreferencesChange,
  status,
  errorMessage,
  onRefresh,
  onNavigate,
}: GraphViewProps): JSX.Element {
  const { fitView, getZoom, getInternalNode, getViewport, setCenter } = useReactFlow<
    CodeGraphFlowNode,
    CodeGraphFlowEdge
  >();
  /** Canvas container, to know the size of the visible area. */
  const canvasRef = useRef<HTMLElement>(null);
  // Hidden files and functions never reach the layout.
  const filtered = useMemo(
    () => applyNodeFilters(fullSnapshot, preferences.nodes),
    [fullSnapshot, preferences.nodes],
  );
  const snapshot = filtered.snapshot;
  // Colors come from the whole graph, so hiding files never recolors the others.
  const folderColorMap = useMemo(
    () =>
      assignFolderColors(
        fullSnapshot.nodes.filter((node) => node.kind === 'file').map((node) => node.filePath),
      ),
    [fullSnapshot],
  );
  const edgeFilters = preferences.connections;
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
  // A filter change lays the graph out again; files shown again start collapsed like new ones.
  const [appliedNodeFilters, setAppliedNodeFilters] = useState({
    filters: preferences.nodes,
    snapshot,
    folderTree,
  });
  if (appliedNodeFilters.filters !== preferences.nodes) {
    setAppliedNodeFilters({ filters: preferences.nodes, snapshot, folderTree });
    setLayoutRequest((request) => request + 1);
    setCollapsedIds((collapsed) =>
      collapseNewContainers(
        collapsed,
        getInitialCollapsedIds(snapshot, collapseMode, folderTree),
        getAllContainerIds(appliedNodeFilters.snapshot, appliedNodeFilters.folderTree),
      ),
    );
  }
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [minimapPreference, setMinimapPreference] = useState<MinimapPreference>('auto');
  const [notice, setNotice] = useState<string | null>(null);
  const [folderColorsEnabled, setFolderColorsEnabled] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState(1);
  const [focusDirection, setFocusDirection] = useState<FocusDirection>('both');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** Node highlighted because the editor cursor is on it (editor sync). */
  const [syncedId, setSyncedId] = useState<string | null>(null);
  // Decorators reuse unchanged node/edge objects so React Flow skips re-rendering them.
  const [nodeDecorator] = useState(() => new ClassNameDecorator<CodeGraphFlowNode>());
  const [edgeDecorator] = useState(() => new ClassNameDecorator<CodeGraphFlowEdge>());
  const [expiredChangeVersion, setExpiredChangeVersion] = useState(0);
  /** Viewport fit to perform once the next layout has been rendered. */
  const pendingFitRef = useRef<FitViewOptions<CodeGraphFlowNode> | null>(null);
  /** Node to center once the next layout has been rendered (editor sync). */
  const pendingCenterRef = useRef<string | null>(null);

  // Recompute the canvas when its inputs change (adjusting state during render):
  // live patches keep file positions; collapse changes and re-layout do not.
  const layoutInputs: ViewLayoutInputs = {
    snapshot,
    collapsedIds,
    folderTree,
    layoutRequest,
    folderColors: folderColorMap,
  };
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
  const focus = useMemo(() => {
    if (focusId === null) {
      return null;
    }
    const result = computeFocus(snapshot, focusId, {
      depth: focusDepth,
      direction: focusDirection,
      imports: edgeFilters.imports,
      calls: edgeFilters.calls,
    });
    // A focused node hidden by a filter ends focus mode.
    return result.nodeIds.size === 0 ? null : result;
  }, [snapshot, focusId, focusDepth, focusDirection, edgeFilters.imports, edgeFilters.calls]);
  const activeFocusId = focus === null ? null : focusId;
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
          node.id === activeFocusId ? 'cg-focus-target' : undefined,
          node.id === syncedId ? 'cg-synced' : undefined,
        ),
      ),
    [
      nodeDecorator,
      current.nodes,
      search,
      highlightedChangeIds,
      focusedIds,
      activeFocusId,
      syncedId,
    ],
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
  const summary = useMemo(() => summarizeGraph(fullSnapshot), [fullSnapshot]);
  const folders = useMemo(
    () =>
      listFolders(
        fullSnapshot.nodes.filter((node) => node.kind === 'file').map((node) => node.filePath),
      ),
    [fullSnapshot],
  );
  const folderColorEntries = useMemo(
    () =>
      listFolderColors(
        fullSnapshot.nodes.filter((node) => node.kind === 'file').map((node) => node.filePath),
      ),
    [fullSnapshot],
  );
  const folderColorOf = useMemo(
    () => new Map(folderColorEntries.map((entry) => [entry.folder, entry.color])),
    [folderColorEntries],
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

  /**
   * Centers a node when it is not fully visible, zooming in up to a readable
   * level but never zooming out.
   *
   * @param nodeId - Displayed node to bring into view.
   */
  const centerOnNode = useCallback(
    (nodeId: string) => {
      const node = getInternalNode(nodeId);
      if (node === undefined) {
        return;
      }
      const { x, y } = node.internals.positionAbsolute;
      const width = node.measured.width ?? 0;
      const height = node.measured.height ?? 0;
      const viewport = getViewport();
      const paneWidth = canvasRef.current?.clientWidth ?? window.innerWidth;
      const paneHeight = canvasRef.current?.clientHeight ?? window.innerHeight;
      const left = x * viewport.zoom + viewport.x;
      const top = y * viewport.zoom + viewport.y;
      const visible =
        viewport.zoom >= SYNC_MIN_ZOOM &&
        left >= SYNC_VISIBLE_MARGIN &&
        top >= SYNC_VISIBLE_MARGIN &&
        left + width * viewport.zoom <= paneWidth - SYNC_VISIBLE_MARGIN &&
        top + height * viewport.zoom <= paneHeight - SYNC_VISIBLE_MARGIN;
      if (!visible) {
        void setCenter(x + width / 2, y + height / 2, {
          zoom: Math.max(viewport.zoom, SYNC_MIN_ZOOM),
          duration: VIEWPORT_ANIMATION_MS,
        });
      }
    },
    [getInternalNode, getViewport, setCenter],
  );

  useEffect(() => {
    const request = pendingFitRef.current;
    const centerId = pendingCenterRef.current;
    if (request === null && centerId === null) {
      return undefined;
    }
    pendingFitRef.current = null;
    pendingCenterRef.current = null;
    // Wait one frame so React Flow has synced (and measured) the new node positions.
    const frame = requestAnimationFrame(() => {
      if (request !== null) {
        void fitView(request);
      } else if (centerId !== null) {
        centerOnNode(centerId);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [current, fitView, centerOnNode]);

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
      if (activeFocusId !== null && node.id !== activeFocusId) {
        enterFocus(node.id);
      }
      onNavigate(node.data.filePath, node.data.line);
    },
    [onNavigate, toggle, activeFocusId, enterFocus],
  );

  const handleNodeContextMenu = useCallback<NodeMouseHandler<CodeGraphFlowNode>>(
    (event, node) => {
      event.preventDefault();
      const target: ContextMenuTarget =
        node.type === 'folder'
          ? { kind: 'folder', nodeId: node.id }
          : { kind: 'node', nodeId: node.id, nodeType: node.type };
      const items = getContextMenuItems(target, activeFocusId !== null);
      setContextMenu(items.length === 0 ? null : { x: event.clientX, y: event.clientY, items });
    },
    [activeFocusId],
  );

  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      event.preventDefault();
      const items = getContextMenuItems({ kind: 'pane' }, activeFocusId !== null);
      setContextMenu(items.length === 0 ? null : { x: event.clientX, y: event.clientY, items });
    },
    [activeFocusId],
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

  // Follow the editor cursor (editor sync): highlight the node and bring it into view.
  useEffect(() => {
    if (revealRequest === null) {
      return;
    }
    onRevealHandled(revealRequest.sequence);
    const { nodeId } = revealRequest;
    if (!snapshot.nodes.some((node) => node.id === nodeId)) {
      return;
    }
    // The request comes from the extension host (an external system) and is applied once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSyncedId(nodeId);
    if (activeFocusId !== null) {
      if (nodeId !== activeFocusId) {
        enterFocus(nodeId);
      }
      return;
    }
    const toExpand = [...getIdsToReveal(snapshot, folderTree, [nodeId])].filter((id) =>
      collapsedIds.has(id),
    );
    if (toExpand.length === 0) {
      centerOnNode(nodeId);
      return;
    }
    pendingCenterRef.current = nodeId;
    setCollapsedIds((collapsed) => {
      const next = new Set(collapsed);
      toExpand.forEach((id) => next.delete(id));
      return next;
    });
  }, [
    revealRequest,
    onRevealHandled,
    snapshot,
    activeFocusId,
    enterFocus,
    folderTree,
    collapsedIds,
    centerOnNode,
  ]);

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

  const focusNode = useMemo(
    () =>
      activeFocusId === null ? undefined : snapshot.nodes.find((item) => item.id === activeFocusId),
    [activeFocusId, snapshot],
  );

  const setConnections = useCallback(
    (connections: ConnectionFilters) => {
      onPreferencesChange({ ...preferences, connections });
    },
    [onPreferencesChange, preferences],
  );

  const setNodeFilters = useCallback(
    (nodes: NodeFilters) => {
      onPreferencesChange({ ...preferences, nodes });
    },
    [onPreferencesChange, preferences],
  );

  const setEditorSync = useCallback(
    (editorSync: boolean) => {
      if (!editorSync) {
        setSyncedId(null);
      }
      onPreferencesChange({ ...preferences, editorSync });
    },
    [onPreferencesChange, preferences],
  );

  const toggleFolderColors = useCallback(() => {
    setFolderColorsEnabled((enabled) => !enabled);
  }, []);

  const toggleMinimap = useCallback(() => {
    setMinimapPreference(showMinimap ? 'off' : 'on');
  }, [showMinimap]);

  const actions = useMemo<GraphActions>(() => ({ toggle }), [toggle]);

  const panel = (
    <Sidebar
      search={{
        query,
        matchCount: search === null ? null : search.matchedIds.size,
        onQueryChange: setQuery,
        onSubmit: zoomToMatches,
      }}
      connections={edgeFilters}
      onConnectionsChange={setConnections}
      filters={{
        filters: preferences.nodes,
        onChange: setNodeFilters,
        folders,
        folderColors: folderColorOf,
        hiddenFiles: filtered.hiddenFiles,
        hiddenFunctions: filtered.hiddenFunctions,
      }}
      focus={{
        label: focusNode === undefined ? null : focusNode.label,
        detail: focusNode === undefined || focusNode.kind === 'file' ? null : focusNode.filePath,
        depth: focusDepth,
        direction: focusDirection,
        onFocusSelected: focusSelected,
        onExit: exitFocus,
        onDepthChange: setFocusDepth,
        onDirectionChange: setFocusDirection,
      }}
      view={{
        onExpandLevel: expandLevel,
        onExpandAll: expandAll,
        onCollapseAll: collapseAll,
        onRelayout: relayout,
        minimapShown: showMinimap,
        onToggleMinimap: toggleMinimap,
        folderColorsEnabled,
        onToggleFolderColors: toggleFolderColors,
        folderColors: folderColorEntries,
        editorSync: preferences.editorSync,
        onEditorSyncChange: setEditorSync,
      }}
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
        <button
          type="button"
          className="cg-toolbar__button cg-toolbar__button--icon"
          aria-pressed={preferences.editorSync}
          title={
            preferences.editorSync
              ? 'Following the editor: the graph highlights the file or function under the cursor. Click to stop.'
              : 'Follow the editor: highlight the file or function under the cursor'
          }
          onClick={() => {
            setEditorSync(!preferences.editorSync);
          }}
        >
          <Icon name="sync" size={14} />
          Sync
        </button>
      </StatusBar>
      <main className="cg-canvas" ref={canvasRef}>
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
