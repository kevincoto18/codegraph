/**
 * Debounces editor cursor moves before they are mirrored in the graph, so
 * typing or holding an arrow key does not flood the webview.
 */

/** Default quiet period before the graph follows the cursor, in milliseconds. */
export const EDITOR_SYNC_DELAY_MS = 250;

/** A cursor position in a document. */
export interface EditorLocation<TUri> {
  /** Document shown in the editor. */
  readonly uri: TUri;
  /** 1-based cursor line. */
  readonly line: number;
}

/**
 * Keeps only the latest editor location and delivers it once the cursor has
 * been still for the configured delay.
 *
 * @template TUri - Document identifier (a `vscode.Uri` in the extension).
 */
export class EditorSyncScheduler<TUri> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: EditorLocation<TUri> | undefined;

  /**
   * Creates the scheduler.
   *
   * @param deliver - Called with the latest location once the cursor is still.
   * @param delayMs - Quiet period, in milliseconds.
   */
  public constructor(
    private readonly deliver: (location: EditorLocation<TUri>) => void,
    private readonly delayMs: number = EDITOR_SYNC_DELAY_MS,
  ) {}

  /**
   * Records a new location and restarts the quiet period.
   *
   * @param location - Latest cursor location.
   */
  public schedule(location: EditorLocation<TUri>): void {
    this.pending = location;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const latest = this.pending;
      this.pending = undefined;
      if (latest !== undefined) {
        this.deliver(latest);
      }
    }, this.delayMs);
  }

  /** Drops the pending location, if any. */
  public cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
  }
}
