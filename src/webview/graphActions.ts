/**
 * React context exposing graph actions to custom node components.
 */
import { createContext, useContext } from 'react';

/** Actions node components can trigger. */
export interface GraphActions {
  /** Collapses or expands a file or folder container. */
  readonly toggle: (containerId: string) => void;
  /** Opens a file or function in the editor (also reveals it in the graph later). */
  readonly open: (nodeId: string, filePath: string, line: number) => void;
}

/** Context carrying the graph actions; provided by `GraphView`. */
export const GraphActionsContext = createContext<GraphActions | null>(null);

/**
 * Returns the graph actions of the nearest provider.
 *
 * @returns The graph actions.
 * @throws Error if used outside a `GraphActionsContext` provider.
 */
export function useGraphActions(): GraphActions {
  const actions = useContext(GraphActionsContext);
  if (actions === null) {
    throw new Error('useGraphActions must be used inside GraphActionsContext.');
  }
  return actions;
}
