import type { NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { Background, Controls, MiniMap, Panel, ReactFlow } from '@xyflow/react';
import type { JSX } from 'react';
import { useState } from 'react';

import { MIN_ZOOM, computeFitViewport, shouldHideEdges, useLowDetail } from './canvasOptions';
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';
import { Legend } from './Legend';
import { nodeTypes } from './nodes/nodeTypes';

/** Props of {@link GraphCanvas}. */
interface GraphCanvasProps {
  readonly nodes: readonly CodeGraphFlowNode[];
  readonly edges: readonly CodeGraphFlowEdge[];
  /** Applies drag/selection changes to the nodes. */
  readonly onNodesChange: OnNodesChange<CodeGraphFlowNode>;
  /** Called when a node is clicked. */
  readonly onNodeClick: NodeMouseHandler<CodeGraphFlowNode>;
  /** Whether the minimap is rendered. */
  readonly showMinimap: boolean;
}

/** Shared empty edge list used while edges are hidden. */
const NO_EDGES: CodeGraphFlowEdge[] = [];

/** Height of the toolbar above the canvas, in pixels (for the initial fit). */
const TOOLBAR_HEIGHT = 40;

/**
 * Presentational React Flow canvas: zoom, pan, file dragging, minimap and
 * controls. State lives in `GraphView`. When zoomed out, the `cg-lod` class
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
  showMinimap,
}: GraphCanvasProps): JSX.Element {
  // Mount at the final zoom (see computeFitViewport) instead of fitting afterwards.
  const [initialViewport] = useState(() =>
    computeFitViewport(nodes, window.innerWidth, window.innerHeight - TOOLBAR_HEIGHT),
  );
  const lowDetail = useLowDetail();
  const edgesHidden = shouldHideEdges(lowDetail, edges.length);
  return (
    <ReactFlow
      className={lowDetail ? 'cg-lod' : undefined}
      nodes={nodes as CodeGraphFlowNode[]}
      edges={edgesHidden ? NO_EDGES : (edges as CodeGraphFlowEdge[])}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={onNodeClick}
      nodesConnectable={false}
      edgesFocusable={false}
      onlyRenderVisibleElements
      zIndexMode="auto"
      minZoom={MIN_ZOOM}
      defaultViewport={initialViewport}
    >
      <Background />
      <Controls showInteractive={false} />
      <Panel position="top-left">
        <Legend edgesHidden={edgesHidden} />
      </Panel>
      {showMinimap && <MiniMap pannable zoomable />}
    </ReactFlow>
  );
}
