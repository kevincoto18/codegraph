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
import { AnalysisCache } from './cache';

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

  /**
   * Creates the service.
   *
   * @param reader - Access to workspace files.
   * @param logger - Destination of diagnostic messages.
   * @param cache - Parse cache (injectable for tests).
   * @param options - Tunable limits.
   */
  public constructor(
    private readonly reader: WorkspaceReader,
    private readonly logger: ServiceLogger,
    private readonly cache: AnalysisCache = new AnalysisCache(),
    options: GraphServiceOptions = {},
  ) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.readConcurrency = options.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
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
      const filePaths = await this.listAnalyzableFiles();
      this.cache.clear();
      const contents = await this.readFiles(filePaths);
      for (const [filePath, content] of contents) {
        this.cache.update(filePath, content);
      }
      this.snapshot = linkGraph(this.cache.getAll(), this.snapshot.version + 1);
      this.logger.info(
        `Scan complete: ${String(contents.size)} files, ${String(this.snapshot.nodes.length)} nodes, ${String(this.snapshot.edges.length)} edges.`,
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
      let content: string;
      try {
        content = await this.reader.readFile(filePath);
      } catch (error) {
        this.logger.error(`Could not read "${filePath}": ${describeError(error)}`);
        return null;
      }
      const { changed } = this.cache.update(filePath, content);
      return changed ? this.relink() : null;
    });
  }

  /**
   * Removes a deleted file from the graph.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The resulting patch, or `null` if the file was not part of the graph.
   */
  public removeFile(filePath: RelPath): Promise<GraphPatch | null> {
    return this.enqueue(() => Promise.resolve(this.cache.delete(filePath) ? this.relink() : null));
  }

  /**
   * Rebuilds the graph from the cache and stores it if anything changed.
   *
   * @returns The patch from the previous snapshot, or `null` if it is empty.
   */
  private relink(): GraphPatch | null {
    const next = linkGraph(this.cache.getAll(), this.snapshot.version + 1);
    const patch = diffSnapshots(this.snapshot, next);
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
