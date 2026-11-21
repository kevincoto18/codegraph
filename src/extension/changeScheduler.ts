/**
 * Per-file debouncing of workspace change events.
 *
 * @remarks Independent of the VS Code API so it can be tested with fake timers.
 */
import type { RelPath } from '../shared';

/** What happened to a file. */
export type FileChangeKind = 'update' | 'remove';

/** Receives a file change once its debounce delay has elapsed. */
export type FileChangeHandler = (filePath: RelPath, kind: FileChangeKind) => void;

/** Default debounce delay, in milliseconds. */
export const DEFAULT_CHANGE_DELAY_MS = 300;

/** A change waiting for its debounce delay. */
interface PendingChange {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly kind: FileChangeKind;
}

/**
 * Coalesces bursts of events for the same file into a single call. The last
 * event wins, so a save followed by a delete within the delay yields `remove`.
 */
export class ChangeScheduler {
  private readonly pending = new Map<RelPath, PendingChange>();

  /**
   * Creates the scheduler.
   *
   * @param handler - Called once per file after its events settle.
   * @param delayMs - Quiet period required before the handler runs.
   */
  public constructor(
    private readonly handler: FileChangeHandler,
    private readonly delayMs: number = DEFAULT_CHANGE_DELAY_MS,
  ) {}

  /** Number of files with a change waiting to be handled. */
  public get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Schedules a change, replacing any pending change of the same file.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param kind - What happened to the file.
   */
  public schedule(filePath: RelPath, kind: FileChangeKind): void {
    const existing = this.pending.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pending.delete(filePath);
      this.handler(filePath, kind);
    }, this.delayMs);
    this.pending.set(filePath, { timer, kind });
  }

  /** Cancels every pending change. */
  public dispose(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }
}
