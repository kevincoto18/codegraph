import type { NodeMouseHandler, OnNodesChange, Viewport } from '@xyflow/react';
import { Background, Controls, MiniMap, Panel, ReactFlow } from '@xyflow/react';
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useState } from 'react';

import type { ScrollBehavior } from '../shared';
import { MIN_ZOOM, computeFitViewport, shouldHideEdges, useLowDetail } from './canvasOptions';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import { nodeTypes } from './nodes/nodeTypes';
import { useCanvasNavigation } from './useCanvasNavigation';

/** Props of {@link GraphCanvas}. */
interface GraphCanvasProps {
  readonly nodes: readonly CodeGraphFlowNode[];
  readonly edges: readonly CodeGraphFlowEdge[];
  /** Applies drag/selection changes to the nodes. */
  readonly onNodesChange: OnNodesChange<CodeGraphFlowNode>;
  /** Called when a node is clicked. */
  readonly onNodeClick: NodeMouseHandler<CodeGraphFlowNode>;
  /** Called when a node is double-clicked (enters focus mode). */
  readonly onNodeDoubleClick: NodeMouseHandler<CodeGraphFlowNode>;
  /** Called when a node is right-clicked (opens the context menu). */
  readonly onNodeContextMenu: NodeMouseHandler<CodeGraphFlowNode>;
  /** Called when the background is right-clicked. */
  readonly onPaneContextMenu: (event: MouseEvent | ReactMouseEvent) => void;
  /** Called when the user starts panning or zooming. */
  readonly onMoveStart: () => void;
  /** Called when panning or zooming ends. */
  readonly onMoveEnd: () => void;
  /** Whether nodes slide to their new position after a layout change. */
  readonly animate: boolean;
  /** Viewport to open at (restored view); fits the graph when `null`. */
  readonly savedViewport: Viewport | null;
  /** Whether the minimap is rendered. */
  readonly showMinimap: boolean;
  /** Whether files and folders show their folder color stripe. */
  readonly folderColors: boolean;
  /** Floating settings panel, rendered at the top left. */
  readonly panel: ReactNode;
  /** What the mouse wheel and two-finger scrolling do. */
  readonly scrollBehavior: ScrollBehavior;
}

/** Shared empty edge list used while edges are hidden. */
const NO_EDGES: CodeGraphFlowEdge[] = [];

/**
 * Class of a node in the minimap, so folders can be drawn as outlines.
 *
 * @param node - Canvas node.
 * @returns The node type.
 */
function minimapNodeClass(node: CodeGraphFlowNode): string {
  return `cg-minimap-${node.type}`;
}

/** Height of the toolbar above the canvas, in pixels (for the initial fit). */
const TOOLBAR_HEIGHT = 40;

/**
 * Presentational React Flow canvas: zoom, pan, file dragging, minimap and
 * controls; wheel, touchpad and keyboard navigation come from
 * `useCanvasNavigation`. State lives in `GraphView`. When zoomed out, the `cg-lod` class
 * switches edges and labels to a cheaper low-detail style, and very large
 * edge sets are not drawn until the user zooms in.
 *
 * @param props - Nodes, edges and interaction callbacks.
 * @returns The canvas element.
 */
export function GraphCanvas({
  nodes,
  edges,
  onNodesChange,
  onNodeClick,
  onNodeDoubleClick,
  onNodeContextMenu,
  onPaneContextMenu,
  onMoveStart,
  onMoveEnd,
  animate,
  savedViewport,
  showMinimap,
  folderColors,
  panel,
  scrollBehavior,
}: GraphCanvasProps): JSX.Element {
  // Mount at the final zoom (see computeFitViewport) instead of fitting afterwards.
  const [initialViewport] = useState(
    () =>
      savedViewport ??
      computeFitViewport(nodes, window.innerWidth, window.innerHeight - TOOLBAR_HEIGHT),
  );
  const lowDetail = useLowDetail();
  const edgesHidden = shouldHideEdges(lowDetail, edges.length);
  const { spacePanning } = useCanvasNavigation(scrollBehavior);
  return (
    <ReactFlow
      className={[
        lowDetail ? 'cg-lod' : '',
        folderColors ? 'cg-colors' : '',
        animate ? 'cg-animate' : '',
        spacePanning ? 'cg-space-pan' : '',
      ]
        .join(' ')
        .trim()}
      nodes={nodes as CodeGraphFlowNode[]}
      edges={edgesHidden ? NO_EDGES : (edges as CodeGraphFlowEdge[])}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeContextMenu={onNodeContextMenu}
      onPaneContextMenu={onPaneContextMenu}
      onMoveStart={onMoveStart}
      onMoveEnd={onMoveEnd}
      zoomOnDoubleClick={false}
      nodesDraggable={!spacePanning}
      panActivationKeyCode={null}
      nodesConnectable={false}
      edgesFocusable={false}
      onlyRenderVisibleElements
      zIndexMode="auto"
      minZoom={MIN_ZOOM}
      defaultViewport={initialViewport}
    >
      <Background />
      <Controls showInteractive={false} />
      <Panel position="top-left">{panel}</Panel>
      {edgesHidden && (
        <Panel position="bottom-center">
          <div className="cg-hint" role="status">
            Zoom in to see the connections
          </div>
        </Panel>
      )}
      {showMinimap && <MiniMap pannable zoomable nodeClassName={minimapNodeClass} />}
    </ReactFlow>
  );
}
