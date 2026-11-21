/**
 * Registry of custom React Flow node components.
 *
 * @remarks Defined at module scope so the object identity is stable across
 * renders, as React Flow requires.
 */
import type { NodeTypes } from '@xyflow/react';

import { FileNode } from './FileNode';
import { FunctionNode } from './FunctionNode';

/** Custom node components by node `type`. */
export const nodeTypes = {
  file: FileNode,
  function: FunctionNode,
} satisfies NodeTypes;
