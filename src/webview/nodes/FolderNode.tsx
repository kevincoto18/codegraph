import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { JSX } from 'react';
import { memo } from 'react';

import { useLowDetail } from '../canvasOptions';
import type { FolderFlowNode } from '../flowTypes';
import { useGraphActions } from '../graphActions';

/**
 * Formats the number of files of a folder.
 *
 * @param count - Number of files.
 * @returns `1 file` or `n files`.
 */
export function formatFileCount(count: number): string {
  return count === 1 ? '1 file' : `${String(count)} files`;
}

/**
 * Renders a folder container: a header with a collapse toggle, the folder
 * name and its file count. Sub-folders and files are rendered inside by React
 * Flow when the folder is expanded. When zoomed out only the name is drawn.
 *
 * @param props - React Flow node props.
 * @returns The folder node element.
 */
function FolderNodeView({ id, data }: NodeProps<FolderFlowNode>): JSX.Element {
  const { toggle } = useGraphActions();
  const lowDetail = useLowDetail();
  const className = `cg-folder${data.collapsed ? ' cg-folder--collapsed' : ''}${lowDetail ? ' cg-folder--lod' : ''}`;
  return (
    <div className={className} title={data.path}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="cg-folder__header">
        {!lowDetail && (
          <button
            type="button"
            className="cg-folder__toggle nodrag"
            aria-label={data.collapsed ? 'Expand folder' : 'Collapse folder'}
            aria-expanded={!data.collapsed}
            onClick={(event) => {
              // The node's own click also toggles; avoid toggling twice.
              event.stopPropagation();
              toggle(id);
            }}
          >
            {data.collapsed ? '▸' : '▾'}
          </button>
        )}
        <span className="cg-folder__name">{data.label}</span>
        {!lowDetail && <span className="cg-folder__count">{formatFileCount(data.fileCount)}</span>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** Memoized folder node (React Flow re-renders nodes often). */
export const FolderNode = memo(FolderNodeView);
