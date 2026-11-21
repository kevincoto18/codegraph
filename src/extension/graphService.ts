/**
 * Orchestrates workspace analysis: initial scan, incremental updates and
 * removals, producing graph snapshots and patches.
 *
 * @remarks Independent of the VS Code API: file access goes through the
 * {@link WorkspaceReader} port, so the service can be unit-tested in memory.
 */
import type { GraphPatch, GraphSnapshot, RelPath } from '../shared';
import { isAnalyzableFile } from './analyzer/config';
import { diffSnapshots, isEmptyPatch } from './analyzer/diff';
import { linkGraph } from './analyzer/linker';
import { parseSource } from './analyzer/parser';
import { AnalysisCache } from './cache';
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

/** Tunable limits of the service. */
export interface GraphServiceOptions {
  /** Maximum number of files analyzed in a workspace. */
  readonly maxFiles?: number;
  /** Number of files read in parallel during a scan. */
  readonly readConcurrency?: number;
  /** Receives per-stage timings; a private tracker is created when omitted. */
  readonly tracker?: PerformanceTracker;
}

/** Default cap on analyzed files, to keep huge repositories responsive. */
const DEFAULT_MAX_FILES = 5000;

/** Default number of parallel file reads. */
const DEFAULT_READ_CONCURRENCY = 32;

/** Snapshot held before the first scan; never sent to the webview. */
const EMPTY_SNAPSHOT: GraphSnapshot = { version: 0, nodes: [], edges: [] };

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
 * All public operations are serialized through an internal queue, so rapid
 * saves can never interleave and produce an inconsistent snapshot.
 */
export class GraphService {
  private snapshot: GraphSnapshot = EMPTY_SNAPSHOT;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxFiles: number;
  private readonly readConcurrency: number;
  private readonly tracker: PerformanceTracker;
  private readonly cache: AnalysisCache;

  /**
   * Creates the service.
   *
   * @param reader - Access to workspace files.
   * @param logger - Destination of diagnostic messages.
   * @param cache - Parse cache (injectable for tests); by default a cache that
   *   reports its timings to the service's tracker.
   * @param options - Tunable limits and the performance tracker.
   */
  public constructor(
    private readonly reader: WorkspaceReader,
    private readonly logger: ServiceLogger,
    cache?: AnalysisCache,
    options: GraphServiceOptions = {},
  ) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.readConcurrency = options.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
    this.tracker = options.tracker ?? new PerformanceTracker();
    this.cache = cache ?? new AnalysisCache(parseSource, this.tracker);
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
    return this.snapshot;
  }

  /**
   * Scans the whole workspace from scratch and rebuilds the graph.
   *
   * @returns The new snapshot.
   */
  public initialize(): Promise<GraphSnapshot> {
    return this.enqueue(async () => {
      const tracker = this.tracker;
      tracker.reset('scan.');
      const startedAt = performance.now();

      const filePaths = await tracker.measureAsync('scan.list', () => this.listAnalyzableFiles());
      this.cache.clear();
      this.cache.setMetricPrefix('scan');
      const contents = await tracker.measureAsync('scan.read', () => this.readFiles(filePaths));
      for (const [filePath, content] of contents) {
        this.cache.update(filePath, content);
      }
      const version = this.snapshot.version + 1;
      this.snapshot = tracker.measure('scan.link', () => linkGraph(this.cache.getAll(), version));

      const totalMs = performance.now() - startedAt;
      tracker.record('scan.total', totalMs);
      tracker.record('scan.files', contents.size, 'count');
      tracker.record('scan.nodes', this.snapshot.nodes.length, 'count');
      tracker.record('scan.edges', this.snapshot.edges.length, 'count');
      this.logger.info(
        `Scan complete: ${String(contents.size)} files, ${String(this.snapshot.nodes.length)} nodes, ${String(this.snapshot.edges.length)} edges in ${totalMs.toFixed(0)} ms.`,
      );
      return this.snapshot;
    });
  }

  /**
   * Re-analyzes a single file (new or modified) and relinks the graph.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The resulting patch, or `null` if the file is not analyzable,
   *   could not be read, or its content (and thus the graph) did not change.
   */
  public updateFile(filePath: RelPath): Promise<GraphPatch | null> {
    return this.enqueue(async () => {
      if (!isAnalyzableFile(filePath)) {
        return null;
      }
      const startedAt = performance.now();
      let content: string;
      try {
        content = await this.tracker.measureAsync('update.read', () =>
          this.reader.readFile(filePath),
        );
      } catch (error) {
        this.logger.error(`Could not read "${filePath}": ${describeError(error)}`);
        return null;
      }
      this.cache.setMetricPrefix('update');
      const { changed } = this.cache.update(filePath, content);
      const patch = changed ? this.relink('update') : null;
      this.tracker.record('update.total', performance.now() - startedAt);
      return patch;
    });
  }

  /**
   * Removes a deleted file from the graph.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The resulting patch, or `null` if the file was not part of the graph.
   */
  public removeFile(filePath: RelPath): Promise<GraphPatch | null> {
    return this.enqueue(() => {
      const startedAt = performance.now();
      const patch = this.cache.delete(filePath) ? this.relink('remove') : null;
      this.tracker.record('remove.total', performance.now() - startedAt);
      return Promise.resolve(patch);
    });
  }

  /**
   * Rebuilds the graph from the cache and stores it if anything changed.
   *
   * @param metricPrefix - Prefix of the `link` and `diff` timing metrics.
   * @returns The patch from the previous snapshot, or `null` if it is empty.
   */
  private relink(metricPrefix: string): GraphPatch | null {
    const version = this.snapshot.version + 1;
    const next = this.tracker.measure(`${metricPrefix}.link`, () =>
      linkGraph(this.cache.getAll(), version),
    );
    const patch = this.tracker.measure(`${metricPrefix}.diff`, () =>
      diffSnapshots(this.snapshot, next),
    );
    if (isEmptyPatch(patch)) {
      return null;
    }
    this.snapshot = next;
    return patch;
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
   * Reads files in bounded parallel batches. Unreadable files are logged and skipped.
   *
   * @param filePaths - Files to read.
   * @returns Content of every readable file, by path.
   */
  private async readFiles(filePaths: readonly RelPath[]): Promise<Map<RelPath, string>> {
    const contents = new Map<RelPath, string>();
    for (let start = 0; start < filePaths.length; start += this.readConcurrency) {
      const batch = filePaths.slice(start, start + this.readConcurrency);
      const results = await Promise.allSettled(batch.map((path) => this.reader.readFile(path)));
      results.forEach((result, index) => {
        const filePath = batch[index];
        if (filePath === undefined) {
          return;
        }
        if (result.status === 'fulfilled') {
          contents.set(filePath, result.value);
        } else {
          this.logger.error(`Could not read "${filePath}": ${describeError(result.reason)}`);
        }
      });
    }
    return contents;
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
