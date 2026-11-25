import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { JSX } from 'react';
import { memo } from 'react';

import { useLowDetail } from '../canvasOptions';
import type { FolderFlowNode } from '../flowTypes';
import { useGraphActions } from '../graphActions';

/** CSS modifier of each language label shown on a workspace folder. */
const LANGUAGE_CLASS: Readonly<Record<string, string>> = {
  TS: 'typescript',
  JS: 'javascript',
  PY: 'python',
  JAVA: 'java',
  'C#': 'csharp',
  GO: 'go',
};

/**
 * Icon of a workspace folder (a folder with a dot), drawn in its color.
 *
 * @returns The icon element.
 */
function WorkspaceRootIcon(): JSX.Element {
  return (
    <svg className="cg-folder__root-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="2.2" fill="currentColor" />
    </svg>
  );
}

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
  const className = [
    'cg-folder',
    data.collapsed ? 'cg-folder--collapsed' : '',
    lowDetail ? 'cg-folder--lod' : '',
    data.isWorkspaceRoot ? 'cg-folder--root' : '',
  ]
    .join(' ')
    .trim();
  const tooltip = data.isWorkspaceRoot
    ? `Workspace folder ${data.label} · ${formatFileCount(data.fileCount)}`
    : `${data.tooltip} · ${formatFileCount(data.fileCount)}`;
  return (
    <div className={className} title={tooltip}>
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
        {data.isWorkspaceRoot && <WorkspaceRootIcon />}
        <span className="cg-folder__name">{data.label}</span>
        {data.isWorkspaceRoot &&
          !lowDetail &&
          data.languages.map((language) => (
            <span
              key={language}
              className={`cg-lang cg-lang--${LANGUAGE_CLASS[language] ?? 'other'}`}
            >
              {language}
            </span>
          ))}
        {!lowDetail && <span className="cg-folder__count">{formatFileCount(data.fileCount)}</span>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** Memoized folder node (React Flow re-renders nodes often). */
export const FolderNode = memo(FolderNodeView);
