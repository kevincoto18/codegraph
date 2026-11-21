import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { JSX } from 'react';
import { memo } from 'react';

import type { FileFlowNode } from '../flowTypes';
import { useGraphActions } from '../graphActions';

/**
 * Returns the short language badge of a file.
 *
 * @param filePath - Workspace-relative path.
 * @returns `TS`, `TSX`, `JS` or `JSX`.
 */
export function getLanguageBadge(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf('.') + 1);
  return extension.toUpperCase();
}

/**
 * Returns the directory part of a workspace-relative path.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @returns The directory (empty for files at the root).
 */
export function getDirectory(filePath: string): string {
  const separator = filePath.lastIndexOf('/');
  return separator === -1 ? '' : filePath.slice(0, separator);
}

/**
 * Renders a file container: a header with a collapse toggle, the file name,
 * directory and function count. Function nodes are rendered inside by React Flow.
 *
 * @param props - React Flow node props.
 * @returns The file node element.
 */
function FileNodeView({ id, data }: NodeProps<FileFlowNode>): JSX.Element {
  const { toggleFile } = useGraphActions();
  const extension = getLanguageBadge(data.filePath);
  const directory = getDirectory(data.filePath);
  return (
    <div className={`cg-file${data.collapsed ? ' cg-file--collapsed' : ''}`} title={data.filePath}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="cg-file__header">
        <button
          type="button"
          className="cg-file__toggle nodrag"
          aria-label={data.collapsed ? 'Expand file' : 'Collapse file'}
          aria-expanded={!data.collapsed}
          disabled={data.functionCount === 0}
          onClick={(event) => {
            // Toggling must not also trigger the node's navigate-on-click.
            event.stopPropagation();
            toggleFile(id);
          }}
        >
          {data.collapsed ? '▸' : '▾'}
        </button>
        <span className={`cg-file__badge cg-file__badge--${extension.toLowerCase()}`}>
          {extension}
        </span>
        <span className="cg-file__name">{data.label}</span>
        {directory !== '' && <span className="cg-file__dir">{directory}</span>}
        <span className="cg-file__count" title="Functions">
          {data.functionCount}
        </span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** Memoized file node (React Flow re-renders nodes often). */
export const FileNode = memo(FileNodeView);
