import type { JSX } from 'react';
import { useMemo } from 'react';

import { GraphCanvas } from './GraphCanvas';
import { summarizeGraph } from './graphChannel';
import { StatusBar } from './StatusBar';
import { useGraphChannel } from './useGraphChannel';

/**
 * Root component of the CodeGraph webview: toolbar plus graph canvas.
 *
 * @returns The webview root element.
 */
export function App(): JSX.Element {
  const { snapshot, status, errorMessage, refresh, navigate } = useGraphChannel();
  const summary = useMemo(() => (snapshot === null ? null : summarizeGraph(snapshot)), [snapshot]);

  return (
    <div className="cg-app">
      <StatusBar
        status={status}
        errorMessage={errorMessage}
        summary={summary}
        onRefresh={refresh}
      />
      <main className="cg-canvas">
        {snapshot === null ? (
          <div className="cg-empty">
            {status === 'error' ? 'Could not build the graph.' : 'Building graph…'}
          </div>
        ) : (
          <GraphCanvas key={snapshot.version} snapshot={snapshot} onNavigate={navigate} />
        )}
      </main>
    </div>
  );
}
