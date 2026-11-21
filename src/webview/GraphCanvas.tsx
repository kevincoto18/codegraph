import type { NodeMouseHandler, OnNodesChange } from '@xyflow/react';
import { Background, Controls, MiniMap, Panel, ReactFlow } from '@xyflow/react';
import type { JSX } from 'react';

import { useLowDetail } from './canvasOptions';
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

/** Smallest zoom level, low enough to fit large projects. */
const MIN_ZOOM = 0.02;

/**
 * Presentational React Flow canvas: zoom, pan, file dragging, minimap and
 * controls. State lives in `GraphView`. When zoomed out, the `cg-lod` class
 * switches edges and labels to a cheaper low-detail style.
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
  const lowDetail = useLowDetail();
  return (
    <ReactFlow
      className={lowDetail ? 'cg-lod' : undefined}
      nodes={nodes as CodeGraphFlowNode[]}
      edges={edges as CodeGraphFlowEdge[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={onNodeClick}
      nodesConnectable={false}
      edgesFocusable={false}
      onlyRenderVisibleElements
      zIndexMode="auto"
      minZoom={MIN_ZOOM}
      fitView
    >
      <Background />
      <Controls showInteractive={false} />
      <Panel position="top-left">
        <Legend />
      </Panel>
      {showMinimap && <MiniMap pannable zoomable />}
    </ReactFlow>
  );
}
