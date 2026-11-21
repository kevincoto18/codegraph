import type { JSX } from 'react';

import { GraphView } from './GraphView';
import { StatusBar } from './StatusBar';
import { useGraphChannel } from './useGraphChannel';

/**
 * Root component of the CodeGraph webview. Shows a placeholder until the
 * first graph arrives, then the graph view. Live patches update the view in
 * place; only a full snapshot (refresh or resync) remounts it.
 *
 * @returns The webview root element.
 */
export function App(): JSX.Element {
  const { snapshot, lastChange, sessionId, status, errorMessage, refresh, navigate } =
    useGraphChannel();

  return (
    <div className="cg-app">
      {snapshot === null ? (
        <>
          <StatusBar
            status={status}
            errorMessage={errorMessage}
            summary={null}
            onRefresh={refresh}
          />
          <main className="cg-canvas">
            <div className="cg-empty">
              {status === 'error' ? 'Could not build the graph.' : 'Building graph…'}
            </div>
          </main>
        </>
      ) : (
        <GraphView
          key={sessionId}
          snapshot={snapshot}
          lastChange={lastChange}
          status={status}
          errorMessage={errorMessage}
          onRefresh={refresh}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}
