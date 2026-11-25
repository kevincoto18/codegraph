import type { FitViewOptions, NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type {
  AnalysisState,
  CollapseMode,
  FolderViewMode,
  ScrollBehavior,
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
import type { FocusDirection, FocusResult } from './focus';
import { computeFocus, getFocusFitIds, getFocusIdsToReveal, getFocusedDisplayIds } from './focus';
import type { FolderTree } from './folders';
import { buildFolderTree, isFolderViewEnabled } from './folders';
import { searchClassOfEdge, searchClassOfNode, toSearchResult, withFolderContext } from './search';
import type { SearchHit } from './searchIndex';
import { buildSearchIndex, searchIndex } from './searchIndex';
import { Legend } from './Legend';
import { Icon } from './icons';
import { applyNodeFilters, listFolders } from './nodeFilters';
import {
  createMountState,
  growMountState,
  isMountComplete,
  selectMountedNodes,
  updateMountState,
} from './progressiveMount';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { assignFolderColors, listFolderColors } from './folderColors';
import type { ViewLayoutInputs, ViewLayoutState } from './viewLayout';
import { computeViewLayout, isViewLayoutCurrent } from './viewLayout';
import { useDebouncedValue } from './useDebouncedValue';
import type { SavedView } from './viewState';
import { describeCollapseChanges, restoreCollapsed } from './viewState';
import type { Box } from './viewportMath';
import {
  CONTAINER_ZOOM,
  FOCUS_MIN_ZOOM,
  FUNCTION_ZOOM,
  viewportForFocus,
  viewportToShowBox,
} from './viewportMath';

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
  /** What the mouse wheel and two-finger scrolling do. */
  readonly scrollBehavior: ScrollBehavior;
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
  /** View to restore (viewport, opened containers, focus, search), or `null`. */
  readonly savedView: SavedView | null;
  /** Called (debounced) with the current view, so it can be restored later. */
  readonly onViewChange: (view: SavedView) => void;
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

/** Quiet period before the view is saved, in milliseconds. */
const VIEW_SAVE_DELAY_MS = 300;

/** Most displayed nodes for which layout changes are animated. */
const MAX_ANIMATED_NODES = 2500;

/** How long connections stay hidden while nodes slide after a layout change, in milliseconds. */
const RELAYOUT_EDGE_HIDE_MS = 260;

/** After a click opens code, a resize within this window keeps the clicked node in view (ms). */
const NAVIGATION_RESIZE_WINDOW_MS = 3000;

/** Shared empty result list used without search. */
const NO_HITS: readonly SearchHit[] = [];

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
  scrollBehavior,
  focusRequest,
  onFocusHandled,
  revealRequest,
  onRevealHandled,
  preferences,
  onPreferencesChange,
  savedView,
  onViewChange,
  status,
  errorMessage,
  onRefresh,
  onNavigate,
}: GraphViewProps): JSX.Element {
  const { fitView, getZoom, getInternalNode, getViewport, setViewport } = useReactFlow<
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
    restoreCollapsed(
      getInitialCollapsedIds(snapshot, collapseMode, folderTree),
      savedView,
      getAllContainerIds(snapshot, folderTree),
    ),
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
  const [query, setQuery] = useState(savedView?.query ?? '');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [minimapPreference, setMinimapPreference] = useState<MinimapPreference>('auto');
  const [notice, setNotice] = useState<string | null>(null);
  const [folderColorsEnabled, setFolderColorsEnabled] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(savedView?.focus?.nodeId ?? null);
  const [focusDepth, setFocusDepth] = useState(savedView?.focus?.depth ?? 1);
  const [focusDirection, setFocusDirection] = useState<FocusDirection>(
    savedView?.focus?.direction ?? 'both',
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** Node highlighted because the editor cursor is on it (editor sync). */
  const [syncedId, setSyncedId] = useState<string | null>(null);
  /** Search result selected in the list, and whether it was shown on the canvas. */
  const [activeMatch, setActiveMatch] = useState({ index: 0, visitedId: null as string | null });
  // Decorators reuse unchanged node/edge objects so React Flow skips re-rendering them.
  const [nodeDecorator] = useState(() => new ClassNameDecorator<CodeGraphFlowNode>());
  const [edgeDecorator] = useState(() => new ClassNameDecorator<CodeGraphFlowEdge>());
  const [expiredChangeVersion, setExpiredChangeVersion] = useState(0);
  /** Viewport fit to perform once the next layout has been rendered. */
  const pendingFitRef = useRef<FitViewOptions<CodeGraphFlowNode> | null>(null);
  /** Node to center once the next layout has been rendered (editor sync, search). */
  const pendingCenterRef = useRef<string | null>(null);
  /** Focus to frame once the next layout has been rendered. */
  const pendingFocusViewRef = useRef<FocusResult | null>(null);

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
  // Many new nodes (e.g. "Expand all") are mounted over several frames, so the view never freezes.
  const [mountState, setMountState] = useState(() => createMountState(current.nodes));
  let mount = mountState;
  if (mountState.source !== current.nodes) {
    mount = updateMountState(mountState, current.nodes);
    setMountState(mount);
  }
  const mountedNodes = useMemo(() => selectMountedNodes(mount), [mount]);
  const mountComplete = isMountComplete(mount);
  const mountedEdges = useMemo(() => {
    if (mountComplete) {
      return current.edges;
    }
    const ids = new Set(mountedNodes.map((node) => node.id));
    return current.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  }, [mountComplete, mountedNodes, current.edges]);

  useEffect(() => {
    if (mountComplete) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      setMountState((state) => growMountState(state));
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [mount, mountComplete]);

  // Time from the first render until the graph is painted.
  const [mountedAt] = useState(() => performance.now());

  const highlightedChangeIds =
    lastChange !== null && lastChange.version > expiredChangeVersion ? lastChange.nodeIds : NO_IDS;

  // The index is only built while searching (≈0.2 s for 60,000 nodes), not on every graph update.
  const searching = query.trim() !== '' || debouncedQuery.trim() !== '';
  const searchData = useMemo(
    () => (searching ? buildSearchIndex(snapshot) : null),
    [snapshot, searching],
  );
  const hits = useMemo(
    () => (searchData === null ? NO_HITS : searchIndex(searchData, debouncedQuery)),
    [searchData, debouncedQuery],
  );
  // A new result list starts again from its best result.
  const [hitsSeen, setHitsSeen] = useState(hits);
  if (hitsSeen !== hits) {
    setHitsSeen(hits);
    setActiveMatch({ index: 0, visitedId: null });
  }
  const search = useMemo(
    () => withFolderContext(toSearchResult(hits, debouncedQuery), folderTree),
    [hits, debouncedQuery, folderTree],
  );
  const currentMatchId = search === null ? null : activeMatch.visitedId;
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
      nodeDecorator.apply(mountedNodes, (node) =>
        joinClassNames(
          searchClassOfNode(node.id, search),
          highlightedChangeIds.has(node.id) ? 'cg-changed' : undefined,
          focusedIds === null || focusedIds.has(node.id) ? undefined : 'cg-focus-dimmed',
          node.id === activeFocusId ? 'cg-focus-target' : undefined,
          node.id === syncedId ? 'cg-synced' : undefined,
          node.id === currentMatchId ? 'cg-current-match' : undefined,
        ),
      ),
    [
      nodeDecorator,
      mountedNodes,
      search,
      highlightedChangeIds,
      focusedIds,
      activeFocusId,
      syncedId,
      currentMatchId,
    ],
  );
  const visibleEdges = useMemo(
    () => filterEdges(mountedEdges, current.nodes, edgeFilters),
    [mountedEdges, current.nodes, edgeFilters],
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
  /**
   * Box of a node on the canvas, in graph coordinates. A function inside a
   * collapsed file falls back to its file.
   *
   * @param nodeId - Model or canvas node id.
   * @returns The box, or `null` when the node is not on the canvas.
   */
  const boxOf = useCallback(
    (nodeId: string): Box | null => {
      let node = getInternalNode(nodeId);
      if (node === undefined) {
        const model = snapshot.nodes.find((item) => item.id === nodeId);
        node = model?.kind === 'function' ? getInternalNode(model.fileId) : undefined;
      }
      if (node === undefined) {
        return null;
      }
      const { x, y } = node.internals.positionAbsolute;
      return { x, y, width: node.measured.width ?? 0, height: node.measured.height ?? 0 };
    },
    [getInternalNode, snapshot],
  );

  /**
   * Current size of the canvas.
   *
   * @returns Width and height in screen pixels.
   */
  const paneSize = useCallback(
    () => ({
      width: canvasRef.current?.clientWidth ?? window.innerWidth,
      height: canvasRef.current?.clientHeight ?? window.innerHeight,
    }),
    [],
  );

  /**
   * Shows a node close up: centered at a readable zoom (functions closer than
   * files and folders), never zooming out, and without moving when it is
   * already visible at that zoom. Tall files are shown from their header.
   *
   * @param nodeId - Node to show.
   */
  const centerOnNode = useCallback(
    (nodeId: string) => {
      const box = boxOf(nodeId);
      if (box === null) {
        return;
      }
      const isFunction = getInternalNode(nodeId)?.type === 'function';
      const viewport = viewportToShowBox(
        box,
        paneSize(),
        getViewport(),
        isFunction ? FUNCTION_ZOOM : CONTAINER_ZOOM,
      );
      if (viewport !== null) {
        void setViewport(viewport, { duration: VIEWPORT_ANIMATION_MS });
      }
    },
    [boxOf, getInternalNode, paneSize, getViewport, setViewport],
  );

  /**
   * Frames a focus: the focused node at the center, zoomed out just enough to
   * show its neighbor functions, never below a readable zoom.
   *
   * @param focus - Focus neighborhood.
   */
  const showFocus = useCallback(
    (focus: FocusResult) => {
      const focusBox = boxOf(focus.focusId);
      if (focusBox === null) {
        return;
      }
      const boxes = getFocusFitIds(snapshot, focus)
        .map(boxOf)
        .filter((box): box is Box => box !== null);
      void setViewport(
        viewportForFocus(focusBox, boxes, paneSize(), FOCUS_MIN_ZOOM, FUNCTION_ZOOM),
        { duration: VIEWPORT_ANIMATION_MS },
      );
    },
    [snapshot, boxOf, paneSize, setViewport],
  );

  /**
   * Opens the folders and file that hide a node, then centers it when it is
   * not fully visible.
   *
   * @param nodeId - File or function to show.
   */
  const bringIntoView = useCallback(
    (nodeId: string) => {
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
    },
    [snapshot, folderTree, collapsedIds, centerOnNode],
  );

  useEffect(() => {
    const request = pendingFitRef.current;
    const centerId = pendingCenterRef.current;
    const focusView = pendingFocusViewRef.current;
    // Fit once every node is mounted, so the fit covers the whole result.
    if ((request === null && centerId === null && focusView === null) || !mountComplete) {
      return undefined;
    }
    pendingFitRef.current = null;
    pendingCenterRef.current = null;
    pendingFocusViewRef.current = null;
    // Wait two frames so React Flow has synced and measured the new nodes.
    let done = false;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        done = true;
        if (request !== null) {
          void fitView(request);
        } else if (focusView !== null) {
          showFocus(focusView);
        } else if (centerId !== null) {
          centerOnNode(centerId);
        }
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      // Measurements re-render the view right after a layout: keep the request for the next run.
      if (!done) {
        pendingFitRef.current ??= request;
        pendingFocusViewRef.current ??= focusView;
        pendingCenterRef.current ??= centerId;
      }
    };
  }, [current, mountComplete, fitView, showFocus, centerOnNode]);

  // After a layout change, nodes slide to their new place (CSS transition); the
  // connections, drawn at the final positions, stay hidden until they arrive.
  const animatedLayoutRef = useRef(current);
  const relayoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const previous = animatedLayoutRef.current;
    animatedLayoutRef.current = current;
    const element = canvasRef.current;
    const layoutChanged =
      previous.collapsedIds !== current.collapsedIds ||
      previous.layoutRequest !== current.layoutRequest ||
      previous.folderTree !== current.folderTree;
    if (!layoutChanged || element === null) {
      return;
    }
    element.classList.add('cg-relayout');
    if (relayoutTimerRef.current !== null) {
      clearTimeout(relayoutTimerRef.current);
    }
    relayoutTimerRef.current = setTimeout(() => {
      relayoutTimerRef.current = null;
      element.classList.remove('cg-relayout');
    }, RELAYOUT_EDGE_HIDE_MS);
  }, [current]);

  useEffect(
    () => () => {
      if (relayoutTimerRef.current !== null) {
        clearTimeout(relayoutTimerRef.current);
      }
    },
    [],
  );

  /** Node whose code was just opened by a click (see the resize handling below). */
  const lastNavigatedRef = useRef<{ readonly id: string; readonly at: number } | null>(null);

  // When the view is resized (e.g. the editor opens beside it), keep the graph
  // centered, and keep a node whose code was just opened in view.
  useEffect(() => {
    const element = canvasRef.current;
    if (element === null) {
      return undefined;
    }
    let width = element.clientWidth;
    let height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const deltaWidth = element.clientWidth - width;
      const deltaHeight = element.clientHeight - height;
      width = element.clientWidth;
      height = element.clientHeight;
      if (deltaWidth === 0 && deltaHeight === 0) {
        return;
      }
      const viewport = getViewport();
      void setViewport({
        x: viewport.x + deltaWidth / 2,
        y: viewport.y + deltaHeight / 2,
        zoom: viewport.zoom,
      });
      const recent = lastNavigatedRef.current;
      if (recent !== null && performance.now() - recent.at < NAVIGATION_RESIZE_WINDOW_MS) {
        centerOnNode(recent.id);
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [getViewport, setViewport, centerOnNode]);

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

  /**
   * Results of the latest query: Enter may arrive before the debounce settles.
   *
   * @returns The ranked hits of what is typed now.
   */
  const latestHits = useCallback(
    (): readonly SearchHit[] =>
      query === debouncedQuery || searchData === null ? hits : searchIndex(searchData, query),
    [query, debouncedQuery, hits, searchData],
  );

  const zoomToMatches = useCallback(() => {
    const latest = latestHits();
    if (latest.length === 0) {
      return;
    }
    const targets = latest.slice(0, MAX_REVEALED_MATCHES).map((hit) => hit.entry.id);
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
  }, [latestHits, snapshot, folderTree, collapsedIds, fitView]);

  /**
   * Shows a search result on the canvas and marks it as the current one.
   *
   * @param index - Index of the result in the ranked list.
   */
  const goToMatch = useCallback(
    (index: number) => {
      const hit = latestHits()[index];
      if (hit === undefined) {
        return;
      }
      setActiveMatch({ index, visitedId: hit.entry.id });
      bringIntoView(hit.entry.id);
    },
    [latestHits, bringIntoView],
  );

  /**
   * Moves to the next or previous search result and shows it.
   *
   * @param delta - `1` for the next result, `-1` for the previous one.
   */
  const stepMatch = useCallback(
    (delta: 1 | -1) => {
      const count = latestHits().length;
      if (count === 0) {
        return;
      }
      // The first step shows the selected result itself.
      const index =
        activeMatch.visitedId === null
          ? Math.min(activeMatch.index, count - 1)
          : (activeMatch.index + delta + count) % count;
      goToMatch(index);
    },
    [latestHits, activeMatch, goToMatch],
  );

  /**
   * Opens a search result in the editor.
   *
   * @param index - Index of the result in the ranked list.
   */
  const openMatch = useCallback(
    (index: number) => {
      const hit = latestHits()[index];
      const node =
        hit === undefined ? undefined : snapshot.nodes.find((item) => item.id === hit.entry.id);
      if (node !== undefined) {
        lastNavigatedRef.current = { id: node.id, at: performance.now() };
        onNavigate(node.filePath, node.line);
      }
    },
    [latestHits, snapshot, onNavigate],
  );

  const selectMatch = useCallback((index: number) => {
    setActiveMatch((current) => (current.index === index ? current : { ...current, index }));
  }, []);

  // F3 / Shift+F3 move between search results from anywhere in the view.
  useEffect(() => {
    /**
     * Handles the F3 shortcuts.
     *
     * @param event - Keyboard event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'F3') {
        event.preventDefault();
        stepMatch(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [stepMatch]);

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
      // Open what hides the focused node and its neighbors, then frame them.
      const toExpand = [...getFocusIdsToReveal(snapshot, neighborhood, folderTree)].filter((id) =>
        collapsedIds.has(id),
      );
      if (toExpand.length > 0) {
        pendingFocusViewRef.current = neighborhood;
        setCollapsedIds((collapsed) => {
          const next = new Set(collapsed);
          toExpand.forEach((id) => next.delete(id));
          return next;
        });
        return;
      }
      showFocus(neighborhood);
    },
    [snapshot, focusDepth, focusDirection, edgeFilters, folderTree, collapsedIds, showFocus],
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
      lastNavigatedRef.current = { id: node.id, at: performance.now() };
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

  // Save the view (debounced) so reopening the panel shows it as it was.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistView = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      onViewChange({
        viewport: getViewport(),
        ...describeCollapseChanges(
          getInitialCollapsedIds(snapshot, collapseMode, folderTree),
          collapsedIds,
        ),
        focus:
          activeFocusId === null
            ? null
            : { nodeId: activeFocusId, depth: focusDepth, direction: focusDirection },
        query,
      });
    }, VIEW_SAVE_DELAY_MS);
  }, [
    onViewChange,
    getViewport,
    snapshot,
    collapseMode,
    folderTree,
    collapsedIds,
    activeFocusId,
    focusDepth,
    focusDirection,
    query,
  ]);

  useEffect(() => {
    persistView();
  }, [persistView]);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    },
    [],
  );

  // While panning or zooming, a lighter style is used (see `.cg-moving` in styles.css).
  // The class is toggled on the DOM directly so moving never re-renders the view.
  const handleMoveStart = useCallback(() => {
    setContextMenu(null);
    canvasRef.current?.classList.add('cg-moving');
  }, []);

  const handleMoveEnd = useCallback(() => {
    canvasRef.current?.classList.remove('cg-moving');
    persistView();
  }, [persistView]);

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
    bringIntoView(nodeId);
  }, [revealRequest, onRevealHandled, snapshot, activeFocusId, enterFocus, bringIntoView]);

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
        onQueryChange: setQuery,
        hits,
        activeIndex: activeMatch.index,
        visited: activeMatch.visitedId !== null,
        onActiveIndexChange: selectMatch,
        onGoTo: goToMatch,
        onOpen: openMatch,
        onStep: stepMatch,
        onShowAll: zoomToMatches,
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
          onMoveStart={handleMoveStart}
          onMoveEnd={handleMoveEnd}
          animate={displayedNodes.length <= MAX_ANIMATED_NODES}
          savedViewport={savedView?.viewport ?? null}
          showMinimap={showMinimap}
          folderColors={folderColorsEnabled}
          panel={panel}
          scrollBehavior={scrollBehavior}
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
