import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { JSX } from 'react';
import { memo } from 'react';

import { useLowDetail } from '../canvasOptions';
import type { FileFlowNode } from '../flowTypes';
import { useGraphActions } from '../graphActions';
import { LanguageBadgeView } from '../LanguageBadgeView';

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
 * "Open file" icon: an arrow leaving a box.
 *
 * @returns The icon element.
 */
function OpenFileIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Renders a file container: a header with a collapse toggle, the file name,
 * directory, function count and an open button. Clicking the header opens or
 * closes the function list (see `GraphView`). Function nodes are rendered inside by React Flow.
 * When zoomed out only the file name is drawn (level of detail).
 *
 * @param props - React Flow node props.
 * @returns The file node element.
 */
function FileNodeView({ id, data }: NodeProps<FileFlowNode>): JSX.Element {
  const { toggle, open } = useGraphActions();
  const directory = getDirectory(data.filePath);
  const lowDetail = useLowDetail();
  if (lowDetail) {
    return (
      <div
        className={`cg-file cg-file--lod${data.collapsed ? ' cg-file--collapsed' : ''}`}
        title={data.tooltip}
      >
        <Handle type="target" position={Position.Left} isConnectable={false} />
        <div className="cg-file__header">
          <span className="cg-file__name">{data.label}</span>
        </div>
        <Handle type="source" position={Position.Right} isConnectable={false} />
      </div>
    );
  }
  return (
    <div className={`cg-file${data.collapsed ? ' cg-file--collapsed' : ''}`} title={data.tooltip}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="cg-file__header">
        <button
          type="button"
          className="cg-file__toggle nodrag"
          aria-label={data.collapsed ? 'Expand file' : 'Collapse file'}
          aria-expanded={!data.collapsed}
          disabled={data.functionCount === 0}
          onClick={(event) => {
            // The header click toggles too; avoid toggling twice.
            event.stopPropagation();
            toggle(id);
          }}
        >
          {data.collapsed ? '▸' : '▾'}
        </button>
        <LanguageBadgeView filePath={data.filePath} />
        <span className="cg-file__name">{data.label}</span>
        {directory !== '' && <span className="cg-file__dir">{directory}</span>}
        <span className="cg-file__count" title="Functions">
          {data.functionCount}
        </span>
        <button
          type="button"
          className="cg-file__open nodrag"
          aria-label="Open file"
          title="Open file (Ctrl + click)"
          onClick={(event) => {
            event.stopPropagation();
            open(id, data.filePath, data.line);
          }}
        >
          <OpenFileIcon />
        </button>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** Memoized file node (React Flow re-renders nodes often). */
export const FileNode = memo(FileNodeView);
