/**
 * Orchestrates workspace analysis: initial scan, incremental updates and
 * removals, producing graph snapshots and patches.
 *
 * @remarks Independent of the VS Code API: file access goes through the
 * {@link WorkspaceReader} port and persistence through the {@link CacheStore}
 * port, so the service can be unit-tested in memory.
 */
import type { GraphPatch, GraphSnapshot, RelPath } from '../shared';
import { isAnalyzableFile } from './analyzer/config';
import { diffSnapshots, isEmptyPatch } from './analyzer/diff';
import { IncrementalLinker } from './analyzer/incrementalLinker';
import { PARSER_VERSION, parseSource } from './analyzer/parser';
import type { ParsedFile } from './analyzer/types';
import type { FileStamp } from './cache';
import { AnalysisCache } from './cache';
import type { CacheStore, GraphStore } from './cacheStore';
import type { ParseJob, ParsePool } from './parsePool';
import type { FileChangeKind } from './changeScheduler';
import { PerformanceTracker } from './perf';

/** Port that gives the service read access to workspace files. */
export interface WorkspaceReader {
  /**
   * Lists candidate source files of the workspace.
   *
   * @returns Workspace-relative POSIX paths.
   */
  listFiles(): Promise<RelPath[]>;
  /**
   * Reads a file as UTF-8 text.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The file content.
   */
  readFile(filePath: RelPath): Promise<string>;
  /**
   * Returns the modification time and size of a file. Optional: without it
   * every file is read on each scan.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The file stamp.
   */
  stat?(filePath: RelPath): Promise<FileStamp>;
}

/** Minimal logging surface (satisfied by `vscode.LogOutputChannel`). */
export interface ServiceLogger {
  /** Logs an informational message. */
  info(message: string): void;
  /** Logs a recoverable problem. */
  warn(message: string): void;
  /** Logs a failure. */
  error(message: string): void;
}

/** Receives scan progress: files processed so far out of the total. */
export type ScanProgressListener = (done: number, total: number) => void;

/** Tunable limits of the service. */
export interface GraphServiceOptions {
  /** Maximum number of files analyzed in a workspace. */
  readonly maxFiles?: number;
  /** Number of files read in parallel during a scan. */
  readonly readConcurrency?: number;
  /** Receives per-stage timings; a private tracker is created when omitted. */
  readonly tracker?: PerformanceTracker;
  /** Persists the parse cache between sessions; nothing is persisted when omitted. */
  readonly store?: CacheStore;
  /** Persists the last graph, shown instantly on the next session; optional. */
  readonly graphStore?: GraphStore;
  /**
   * Creates a pool that parses on worker threads during large scans (it is
   * disposed after each scan). Omitted or returning `null`: parse inline.
   */
  readonly createParsePool?: () => ParsePool | null;
  /** Delay before persisting the cache after live updates, in milliseconds. */
  readonly persistDelayMs?: number;
}

/** Version of the persisted cache layout. */
const CACHE_SCHEMA_VERSION = 1;

/**
 * Compatibility key of the persisted cache: changes whenever the cache layout
 * or the parser output changes.
 */
export const ANALYSIS_CACHE_KEY = `schema${String(CACHE_SCHEMA_VERSION)}-parser${String(PARSER_VERSION)}`;

/** Default cap on analyzed files, to keep huge repositories responsive. */
const DEFAULT_MAX_FILES = 5000;

/** Default number of parallel file reads. */
const DEFAULT_READ_CONCURRENCY = 32;

/**
 * Largest share of changed nodes for which {@link GraphService.revalidate}
 * returns a patch; above it, sending the whole graph is cheaper.
 */
const MAX_REVALIDATION_CHANGE_RATIO = 0.2;

/** Changed nodes always accepted in a revalidation patch, whatever the graph size. */
const MIN_REVALIDATION_PATCH_NODES = 1000;

/** Result of {@link GraphService.revalidate}. */
export interface RevalidationResult {
  /** The up-to-date graph. */
  readonly snapshot: GraphSnapshot;
  /**
   * Changes from the saved graph to the up-to-date one (possibly empty), or
   * `null` when they are too large and the whole graph should be sent instead.
   */
  readonly patch: GraphPatch | null;
}

/**
 * Fewest files to parse for a scan to use worker threads. Each worker loads
 * its own TypeScript compiler (~0.3 s), which only pays off on large scans;
 * smaller scans parse inline.
 */
export const MIN_FILES_FOR_WORKERS = 3000;

/** Default delay before persisting the cache after live updates. */
const DEFAULT_PERSIST_DELAY_MS = 2000;

/**
 * Converts an unknown thrown value into a readable message.
 *
 * @param error - Caught value.
 * @returns The error message.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the workspace graph up to date.
 *
 * All operations are serialized through an internal queue, so changes can
 * never interleave and produce an inconsistent graph. Changes submitted while
 * the queue is busy are coalesced: every save and deletion waiting in line is
 * applied in a single batch that produces a single patch.
 */
export class GraphService {
  private readonly linker = new IncrementalLinker();
  private currentVersion = 0;
  private snapshot: GraphSnapshot = { version: 0, nodes: [], edges: [] };
  private snapshotStale = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Changes waiting for the next batch, by file (the last change wins). */
  private readonly pending = new Map<RelPath, FileChangeKind>();
  /** Result of the batch that will apply {@link pending}, once scheduled. */
  private pendingBatch: Promise<GraphPatch | null> | null = null;
  private persistedCacheLoaded = false;
  private scanned = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persisting: Promise<void> = Promise.resolve();
  private readonly maxFiles: number;
  private readonly readConcurrency: number;
  private readonly persistDelayMs: number;
  private readonly tracker: PerformanceTracker;
  private readonly cache: AnalysisCache;
  private readonly store: CacheStore | undefined;
  private readonly graphStore: GraphStore | undefined;
  private readonly createParsePool: (() => ParsePool | null) | undefined;

  /**
   * Creates the service.
   *
   * @param reader - Access to workspace files.
   * @param logger - Destination of diagnostic messages.
   * @param cache - Parse cache (injectable for tests); by default a cache that
   *   reports its timings to the service's tracker.
   * @param options - Tunable limits, persistence and the performance tracker.
   */
  public constructor(
    private readonly reader: WorkspaceReader,
    private readonly logger: ServiceLogger,
    cache?: AnalysisCache,
    options: GraphServiceOptions = {},
  ) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.readConcurrency = options.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
    this.persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
    this.tracker = options.tracker ?? new PerformanceTracker();
    this.cache = cache ?? new AnalysisCache(parseSource, this.tracker);
    this.store = options.store;
    this.graphStore = options.graphStore;
    this.createParsePool = options.createParsePool;
  }

  /** Per-stage timings of scans, updates and removals. */
  public get performance(): PerformanceTracker {
    return this.tracker;
  }

  /**
   * Returns the latest snapshot.
   *
   * @returns The current graph (version 0 before {@link initialize}).
   */
  public getSnapshot(): GraphSnapshot {
    if (this.snapshotStale) {
      this.snapshot = this.linker.snapshot(this.currentVersion);
      this.snapshotStale = false;
    }
    return this.snapshot;
  }

  /** Version of the current graph (0 before the first scan or saved graph). */
  public get version(): number {
    return this.currentVersion;
  }

  /** Whether the workspace has been scanned in this session. */
  public get hasScanned(): boolean {
    return this.scanned;
  }

  /**
   * Loads the graph saved by the previous session, so it can be shown before
   * the workspace is rescanned. The next scan continues its version numbering,
   * so {@link revalidate} can express the differences as the next patch.
   *
   * @returns The saved graph, or `null` if there is none or a scan already ran.
   */
  public async loadSavedGraph(): Promise<GraphSnapshot | null> {
    if (this.graphStore === undefined || this.currentVersion !== 0) {
      return null;
    }
    const saved = await this.tracker.measureAsync('saved.load', () =>
      this.graphStore === undefined ? Promise.resolve(null) : this.graphStore.load(),
    );
    // A scan may have finished while the file was loading: it is more recent.
    if (saved === null || this.version !== 0) {
      return null;
    }
    this.currentVersion = saved.version;
    return saved;
  }

  /**
   * Rescans the workspace after a saved graph was shown, and computes what changed.
   *
   * @param saved - Graph returned by {@link loadSavedGraph}.
   * @param onProgress - Optional listener of the scan progress.
   * @returns The up-to-date graph and the patch from the saved one.
   */
  public async revalidate(
    saved: GraphSnapshot,
    onProgress?: ScanProgressListener,
  ): Promise<RevalidationResult> {
    const snapshot = await this.initialize(onProgress);
    if (snapshot.version !== saved.version + 1) {
      return { snapshot, patch: null };
    }
    const patch = this.tracker.measure('saved.diff', () => diffSnapshots(saved, snapshot));
    const changedNodes = patch.upsertNodes.length + patch.removeNodeIds.length;
    const allowed = Math.max(
      MIN_REVALIDATION_PATCH_NODES,
      MAX_REVALIDATION_CHANGE_RATIO * snapshot.nodes.length,
    );
    const tooLarge = changedNodes > allowed;
    return { snapshot, patch: tooLarge ? null : patch };
  }

  /**
   * Checks whether a file is part of the graph.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns `true` if the file is analyzed.
   */
  public hasFile(filePath: RelPath): boolean {
    return this.linker.has(filePath);
  }

  /**
   * Lists the files of the graph.
   *
   * @returns Workspace-relative paths, in no particular order.
   */
  public getFilePaths(): RelPath[] {
    return this.linker.getFilePaths();
  }

  /**
   * Scans the workspace and rebuilds the graph. Files whose modification time
   * and size match the (possibly persisted) cache are not read again.
   *
   * @param onProgress - Optional listener of the scan progress.
   * @returns The new snapshot.
   */
  public initialize(onProgress?: ScanProgressListener): Promise<GraphSnapshot> {
    return this.enqueue(async () => {
      const tracker = this.tracker;
      tracker.reset('scan.');
      const startedAt = performance.now();

      await tracker.measureAsync('scan.cacheLoad', () => this.loadPersistedCache());
      const filePaths = await tracker.measureAsync('scan.list', () => this.listAnalyzableFiles());
      this.cache.setMetricPrefix('scan');
      const stamps = await tracker.measureAsync('scan.stat', () => this.statFiles(filePaths));
      const toRead = filePaths.filter(
        (filePath) => !this.cache.isFresh(filePath, stamps.get(filePath)),
      );
      const reused = filePaths.length - toRead.length;
      onProgress?.(reused, filePaths.length);

      const contents = await tracker.measureAsync('scan.read', () =>
        this.readFiles(toRead, (read) => {
          onProgress?.(reused + read, filePaths.length);
        }),
      );
      const failed = new Set(toRead.filter((filePath) => !contents.has(filePath)));
      await this.parseContents(contents, stamps);
      const analyzed = filePaths.filter((filePath) => !failed.has(filePath));
      this.cache.retain(new Set(analyzed));

      const parsedFiles = analyzed
        .map((filePath) => this.cache.get(filePath))
        .filter((parsed): parsed is ParsedFile => parsed !== undefined);
      tracker.measure('scan.link', () => {
        this.linker.clear();
        this.linker.apply({ upserts: parsedFiles, removals: [] });
      });
      this.currentVersion += 1;
      this.snapshotStale = true;
      this.scanned = true;
      const snapshot = this.getSnapshot();

      const totalMs = performance.now() - startedAt;
      tracker.record('scan.total', totalMs);
      tracker.record('scan.files', parsedFiles.length, 'count');
      tracker.record('scan.reused', reused, 'count');
      tracker.record('scan.nodes', snapshot.nodes.length, 'count');
      tracker.record('scan.edges', snapshot.edges.length, 'count');
      this.logger.info(
        `Scan complete: ${String(parsedFiles.length)} files (${String(reused)} unchanged since last session), ${String(snapshot.nodes.length)} nodes, ${String(snapshot.edges.length)} edges in ${totalMs.toFixed(0)} ms.`,
      );
      this.persistNow();
      return snapshot;
    });
  }

  /**
   * Parses the files whose content is not cached, on worker threads when
   * there are many of them, and stores the results in the cache.
   *
   * @param contents - Content of the files read by the scan.
   * @param stamps - Stamps of the files, when known.
   */
  private async parseContents(
    contents: ReadonlyMap<RelPath, string>,
    stamps: ReadonlyMap<RelPath, FileStamp>,
  ): Promise<void> {
    const jobs: (ParseJob & { readonly hash: string })[] = [];
    for (const [filePath, content] of contents) {
      const { hash, cached } = this.cache.lookup(filePath, content, stamps.get(filePath));
      if (cached === undefined) {
        jobs.push({ filePath, content, hash });
      }
    }
    const pool = jobs.length >= MIN_FILES_FOR_WORKERS ? (this.createParsePool?.() ?? null) : null;
    if (pool !== null) {
      try {
        const results = await this.tracker.measureAsync('scan.parse', () => pool.parseAll(jobs));
        jobs.forEach((job, index) => {
          const parsed = results[index];
          if (parsed !== undefined) {
            this.cache.store(job.filePath, job.hash, parsed, stamps.get(job.filePath));
          }
        });
        this.tracker.record('scan.parseWorkers', 1, 'count');
        return;
      } catch (error) {
        this.logger.warn(`Parallel parsing failed, parsing inline: ${describeError(error)}`);
      } finally {
        await pool.dispose();
      }
    }
    for (const job of jobs) {
      this.cache.update(job.filePath, job.content, stamps.get(job.filePath));
    }
  }

  /**
   * Re-analyzes a new or modified file. The change joins every other change
   * waiting in line and they are applied together.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The patch of the batch that applied the change (shared by every
   *   change of that batch), or `null` if the graph did not change.
   */
  public updateFile(filePath: RelPath): Promise<GraphPatch | null> {
    if (!isAnalyzableFile(filePath)) {
      return Promise.resolve(null);
    }
    return this.submit(filePath, 'update');
  }

  /**
   * Removes a deleted file from the graph. The change joins every other change
   * waiting in line and they are applied together.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The patch of the batch that applied the change (shared by every
   *   change of that batch), or `null` if the graph did not change.
   */
  public removeFile(filePath: RelPath): Promise<GraphPatch | null> {
    return this.submit(filePath, 'remove');
  }

  /**
   * Writes any pending cache changes to the store and stops the persist timer.
   *
   * @returns Resolves once the cache is saved.
   */
  public async dispose(): Promise<void> {
    if (this.persistTimer !== undefined) {
      this.persistNow();
    }
    await this.persisting;
  }

  /**
   * Adds a change to the next batch, scheduling the batch if needed.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param kind - What happened to the file.
   * @returns The result of the batch that will apply the change.
   */
  private submit(filePath: RelPath, kind: FileChangeKind): Promise<GraphPatch | null> {
    this.pending.set(filePath, kind);
    this.pendingBatch ??= this.enqueue(() => this.applyPendingChanges());
    return this.pendingBatch;
  }

  /**
   * Applies every pending change in one incremental relink.
   *
   * @returns The resulting patch, or `null` if the graph did not change.
   */
  private async applyPendingChanges(): Promise<GraphPatch | null> {
    const batch = [...this.pending];
    this.pending.clear();
    this.pendingBatch = null;

    const startedAt = performance.now();
    const updates = batch.filter(([, kind]) => kind === 'update').map(([filePath]) => filePath);
    const removals = batch.filter(([, kind]) => kind === 'remove').map(([filePath]) => filePath);
    const prefix = updates.length > 0 ? 'update' : 'remove';
    this.cache.setMetricPrefix(prefix);

    const [stamps, contents] = await Promise.all([
      this.statFiles(updates),
      this.tracker.measureAsync(`${prefix}.read`, () => this.readFiles(updates)),
    ]);
    const upserts: ParsedFile[] = [];
    for (const [filePath, content] of contents) {
      const { parsed, changed } = this.cache.update(filePath, content, stamps.get(filePath));
      if (changed || !this.linker.has(filePath)) {
        upserts.push(parsed);
      }
    }
    const removed = removals.filter((filePath) => {
      this.cache.delete(filePath);
      return this.linker.has(filePath);
    });

    let patch: GraphPatch | null = null;
    if (upserts.length > 0 || removed.length > 0) {
      const delta = this.tracker.measure(`${prefix}.link`, () =>
        this.linker.apply({ upserts, removals: removed }),
      );
      if (!isEmptyPatch(delta)) {
        this.currentVersion += 1;
        this.snapshotStale = true;
        patch = { version: this.currentVersion, ...delta };
        this.schedulePersist();
      }
    }
    this.tracker.record(`${prefix}.batch`, batch.length, 'count');
    this.tracker.record(`${prefix}.total`, performance.now() - startedAt);
    return patch;
  }

  /**
   * Loads the persisted cache once per service, before the first scan.
   */
  private async loadPersistedCache(): Promise<void> {
    if (this.persistedCacheLoaded || this.store === undefined) {
      return;
    }
    this.persistedCacheLoaded = true;
    const entries = await this.store.load();
    if (this.cache.size === 0 && entries.length > 0) {
      this.cache.importEntries(entries);
      this.logger.info(`Loaded ${String(entries.length)} cached files from the previous session.`);
    }
  }

  /** Persists the cache after a quiet period, so bursts of saves write once. */
  private schedulePersist(): void {
    if (this.store === undefined && this.graphStore === undefined) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistNow();
    }, this.persistDelayMs);
  }

  /**
   * Saves the cache and the graph now (after any save still in progress).
   * Failures are logged.
   */
  private persistNow(): void {
    const { store, graphStore } = this;
    if (store === undefined && graphStore === undefined) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.persisting = this.persisting
      .then(async () => {
        await store?.save(this.cache.exportEntries());
        if (graphStore !== undefined && this.scanned) {
          await graphStore.save(this.getSnapshot());
        }
      })
      .catch((error: unknown) => {
        this.logger.warn(`Could not persist the analysis: ${describeError(error)}`);
      });
  }

  /**
   * Lists the analyzable files of the workspace, sorted and capped.
   *
   * @returns At most `maxFiles` workspace-relative paths.
   */
  private async listAnalyzableFiles(): Promise<RelPath[]> {
    const filePaths = (await this.reader.listFiles()).filter(isAnalyzableFile).sort();
    if (filePaths.length > this.maxFiles) {
      this.logger.warn(
        `Workspace has ${String(filePaths.length)} source files; only the first ${String(this.maxFiles)} are analyzed.`,
      );
      return filePaths.slice(0, this.maxFiles);
    }
    return filePaths;
  }

  /**
   * Gets the stamps of files in bounded parallel batches, when the reader
   * supports it. Files that cannot be stat-ed are simply left out.
   *
   * @param filePaths - Files to inspect.
   * @returns Stamps by path (empty if the reader has no `stat`).
   */
  private async statFiles(filePaths: readonly RelPath[]): Promise<Map<RelPath, FileStamp>> {
    const stamps = new Map<RelPath, FileStamp>();
    const stat = this.reader.stat?.bind(this.reader);
    if (stat === undefined) {
      return stamps;
    }
    await this.forEachBatch(filePaths, stat, (filePath, stamp) => {
      stamps.set(filePath, stamp);
    });
    return stamps;
  }

  /**
   * Reads files in bounded parallel batches. Unreadable files are logged and skipped.
   *
   * @param filePaths - Files to read.
   * @param onRead - Optional listener receiving the number of files processed so far.
   * @returns Content of every readable file, by path.
   */
  private async readFiles(
    filePaths: readonly RelPath[],
    onRead?: (processed: number) => void,
  ): Promise<Map<RelPath, string>> {
    const contents = new Map<RelPath, string>();
    await this.forEachBatch(
      filePaths,
      (filePath) => this.reader.readFile(filePath),
      (filePath, content) => {
        contents.set(filePath, content);
      },
      (filePath, error) => {
        this.logger.error(`Could not read "${filePath}": ${describeError(error)}`);
      },
      onRead,
    );
    return contents;
  }

  /**
   * Runs an asynchronous operation on every file, `readConcurrency` at a time.
   *
   * @param filePaths - Files to process.
   * @param operation - Operation run on each file.
   * @param onSuccess - Receives each successful result.
   * @param onFailure - Receives each failure (ignored when omitted).
   * @param onProgress - Receives the number of files processed after each batch.
   */
  private async forEachBatch<T>(
    filePaths: readonly RelPath[],
    operation: (filePath: RelPath) => Promise<T>,
    onSuccess: (filePath: RelPath, value: T) => void,
    onFailure?: (filePath: RelPath, error: unknown) => void,
    onProgress?: (processed: number) => void,
  ): Promise<void> {
    for (let start = 0; start < filePaths.length; start += this.readConcurrency) {
      const batch = filePaths.slice(start, start + this.readConcurrency);
      const results = await Promise.allSettled(batch.map(operation));
      results.forEach((result, index) => {
        const filePath = batch[index];
        if (filePath === undefined) {
          return;
        }
        if (result.status === 'fulfilled') {
          onSuccess(filePath, result.value);
        } else {
          onFailure?.(filePath, result.reason);
        }
      });
      onProgress?.(start + batch.length);
    }
  }

  /**
   * Runs a task after every previously queued task has settled.
   *
   * @param task - Operation to serialize.
   * @returns The task's result.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
