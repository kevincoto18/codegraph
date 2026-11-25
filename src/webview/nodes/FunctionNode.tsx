import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { JSX } from 'react';
import { memo } from 'react';

import type { FunctionKind } from '../../shared';
import { useLowDetail } from '../canvasOptions';
import type { FunctionFlowNode } from '../flowTypes';

/** Short symbol shown for each function kind. */
const KIND_BADGES: Readonly<Record<FunctionKind, string>> = {
  function: 'ƒ',
  arrow: '⇒',
  method: 'm',
};

/**
 * Renders a function row inside its file container. When zoomed out it is
 * drawn as an empty bar (level of detail).
 *
 * @param props - React Flow node props.
 * @returns The function node element.
 */
function FunctionNodeView({ data }: NodeProps<FunctionFlowNode>): JSX.Element {
  const lowDetail = useLowDetail();
  if (lowDetail) {
    return (
      <div className={`cg-fn cg-fn--lod cg-fn--${data.functionKind}`}>
        <Handle type="target" position={Position.Left} isConnectable={false} />
        <Handle type="source" position={Position.Right} isConnectable={false} />
      </div>
    );
  }
  return (
    <div className={`cg-fn cg-fn--${data.functionKind}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="cg-fn__badge">{KIND_BADGES[data.functionKind]}</span>
      <span className="cg-fn__name">{data.label}</span>
      {data.exported && <span className="cg-fn__exported" aria-label="exported" />}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** Memoized function node (React Flow re-renders nodes often). */
export const FunctionNode = memo(FunctionNodeView);
