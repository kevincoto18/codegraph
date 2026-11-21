/**
 * Registry of custom React Flow node components.
 *
 * @remarks Defined at module scope so the object identity is stable across
 * renders, as React Flow requires.
 */
import type { NodeTypes } from '@xyflow/react';

import { FileNode } from './FileNode';
import { FolderNode } from './FolderNode';
import { FunctionNode } from './FunctionNode';

/** Custom node components by node `type`. */
export const nodeTypes = {
  folder: FolderNode,
  file: FileNode,
  function: FunctionNode,
} satisfies NodeTypes;
