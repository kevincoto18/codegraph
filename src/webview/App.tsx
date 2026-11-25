import type { JSX } from 'react';
import { useCallback, useState } from 'react';

import type { ViewPreferences } from '../shared';
import { DEFAULT_VIEW_PREFERENCES } from '../shared';
import { GraphView } from './GraphView';
import { DEFAULT_REVIEW_DEPTH } from './review';
import { StatusBar } from './StatusBar';
import { useGraphChannel } from './useGraphChannel';
import { loadSavedView, saveView } from './vscodeApi';

/**
 * Root component of the CodeGraph webview. Shows a placeholder until the
 * first graph arrives, then the graph view. Live patches update the view in
 * place; only a full snapshot (refresh or resync) remounts it.
 *
 * @returns The webview root element.
 */
export function App(): JSX.Element {
  const {
    snapshot,
    lastChange,
    sessionId,
    options,
    status,
    errorMessage,
    focusRequest,
    revealRequest,
    preferences: storedPreferences,
    review,
    reviewOpenRequest,
    reviewBranches,
    reviewBranch,
    refresh,
    navigate,
    savePreferences,
    requestReview,
    copyText,
  } = useGraphChannel();
  // Kept here so a new snapshot (which remounts the view) keeps the chosen depth.
  const [reviewDepth, setReviewDepth] = useState(DEFAULT_REVIEW_DEPTH);
  // Edited locally for instant feedback; the host stores every change and
  // sends the stored copy on (re)connection.
  const [preferences, setPreferences] = useState<ViewPreferences>(
    storedPreferences ?? DEFAULT_VIEW_PREFERENCES,
  );
  const [adoptedPreferences, setAdoptedPreferences] = useState(storedPreferences);
  if (storedPreferences !== adoptedPreferences) {
    setAdoptedPreferences(storedPreferences);
    if (storedPreferences !== null) {
      setPreferences(storedPreferences);
    }
  }
  const changePreferences = useCallback(
    (next: ViewPreferences) => {
      setPreferences(next);
      savePreferences(next);
    },
    [savePreferences],
  );
  // Survives remounts of the view (new snapshot), so a focus is applied once.
  const [handledFocus, setHandledFocus] = useState(0);
  const pendingFocus =
    focusRequest !== null && focusRequest.sequence > handledFocus ? focusRequest : null;
  const markFocusHandled = useCallback((sequence: number) => {
    setHandledFocus((handled) => Math.max(handled, sequence));
  }, []);
  const [handledReviewOpen, setHandledReviewOpen] = useState(0);
  const pendingReviewOpen = reviewOpenRequest > handledReviewOpen ? reviewOpenRequest : null;
  const markReviewOpenHandled = useCallback((sequence: number) => {
    setHandledReviewOpen((handled) => Math.max(handled, sequence));
  }, []);
  const [handledReveal, setHandledReveal] = useState(0);
  const pendingReveal =
    revealRequest !== null && revealRequest.sequence > handledReveal ? revealRequest : null;
  const markRevealHandled = useCallback((sequence: number) => {
    setHandledReveal((handled) => Math.max(handled, sequence));
  }, []);

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
          collapseMode={options.collapseMode}
          folderViewMode={options.folderViewMode}
          scrollBehavior={options.scrollBehavior}
          workspaceRoots={options.workspaceRoots}
          focusRequest={pendingFocus}
          onFocusHandled={markFocusHandled}
          revealRequest={pendingReveal}
          onRevealHandled={markRevealHandled}
          preferences={preferences}
          onPreferencesChange={changePreferences}
          savedView={loadSavedView()}
          onViewChange={saveView}
          status={status}
          errorMessage={errorMessage}
          onRefresh={refresh}
          onNavigate={navigate}
          review={review}
          reviewBranches={reviewBranches}
          reviewBranch={reviewBranch}
          reviewDepth={reviewDepth}
          onReviewDepthChange={setReviewDepth}
          onReviewRequest={requestReview}
          reviewOpenRequest={pendingReviewOpen}
          onReviewOpenHandled={markReviewOpenHandled}
          onCopyText={copyText}
        />
      )}
    </div>
  );
}
