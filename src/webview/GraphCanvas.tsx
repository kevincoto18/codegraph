import type { NodeMouseHandler } from '@xyflow/react';
import { Background, Controls, MiniMap, ReactFlow, useNodesState } from '@xyflow/react';
import type { JSX } from 'react';
import { useCallback, useMemo } from 'react';

import type { GraphSnapshot, RelPath } from '../shared';
import type { CodeGraphFlowNode } from './flowTypes';
import { buildFlowGraph } from './layout';
import { nodeTypes } from './nodes/nodeTypes';

/** Props of {@link GraphCanvas}. */
interface GraphCanvasProps {
  /** Graph to render. Remount the canvas (via `key`) to load a new snapshot. */
  readonly snapshot: GraphSnapshot;
  /** Called when a node is clicked, to open its source. */
  readonly onNavigate: (filePath: RelPath, line: number) => void;
}

/** Smallest zoom level, low enough to fit large projects. */
const MIN_ZOOM = 0.05;

/**
 * Interactive graph canvas: laid-out files and functions with zoom, pan,
 * dragging of files, a minimap and click-to-navigate.
 *
 * @param props - Snapshot and navigation callback.
 * @returns The canvas element.
 */
export function GraphCanvas({ snapshot, onNavigate }: GraphCanvasProps): JSX.Element {
  const layout = useMemo(() => buildFlowGraph(snapshot), [snapshot]);
  const [nodes, , onNodesChange] = useNodesState<CodeGraphFlowNode>(layout.nodes);

  const handleNodeClick = useCallback<NodeMouseHandler<CodeGraphFlowNode>>(
    (_event, node) => {
      onNavigate(node.data.filePath, node.data.line);
    },
    [onNavigate],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={layout.edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={handleNodeClick}
      nodesConnectable={false}
      edgesFocusable={false}
      onlyRenderVisibleElements
      minZoom={MIN_ZOOM}
      fitView
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
