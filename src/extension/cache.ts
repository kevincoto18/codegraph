/**
 * Cache of parser results keyed by file, invalidated by content hash. Entries
 * can be exported and restored so the cache survives VS Code restarts.
 */
import { createHash } from 'node:crypto';

import type { RelPath } from '../shared';
import { parseSource } from './analyzer/parser';
import type { ParsedFile } from './analyzer/types';
import type { PerformanceTracker } from './perf';

/** Signature of the function used to parse a file. */
export type ParseFunction = (filePath: RelPath, content: string) => ParsedFile;

/** Outcome of feeding a file's content to the cache. */
export interface CacheUpdateResult {
  /** Parser output for the current content. */
  readonly parsed: ParsedFile;
  /** `false` when the content hash matched the cached entry and no parsing happened. */
  readonly changed: boolean;
}

/** Modification time and size of a file, used to skip reading unchanged files. */
export interface FileStamp {
  /** Last modification time, in milliseconds since the epoch. */
  readonly mtime: number;
  /** Size in bytes. */
  readonly size: number;
}

/** A cached parse result together with the hash of the content it came from. */
export interface CacheEntry {
  readonly filePath: RelPath;
  readonly hash: string;
  readonly parsed: ParsedFile;
  /** Stamp of the file when it was read, if known. */
  readonly stamp?: FileStamp;
}

/**
 * Compares two file stamps.
 *
 * @param a - First stamp.
 * @param b - Second stamp.
 * @returns `true` if both are defined and equal.
 */
export function isSameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.mtime === b.mtime && a.size === b.size;
}

/**
 * Computes the SHA-256 hash of a file's content.
 *
 * @param content - File text.
 * @returns Lowercase hexadecimal digest.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Stores the parse result of every analyzed file and skips re-parsing files
 * whose content did not change.
 */
export class AnalysisCache {
  private readonly entries = new Map<RelPath, CacheEntry>();
  /** Prefix of the timing metrics (`<prefix>.hash`, `<prefix>.parse`). */
  private metricPrefix = 'cache';

  /**
   * Creates an empty cache.
   *
   * @param parse - Parser used for new or changed content (injectable for tests).
   * @param tracker - Optional tracker receiving `<prefix>.hash` and `<prefix>.parse` timings.
   */
  public constructor(
    private readonly parse: ParseFunction = parseSource,
    private readonly tracker?: PerformanceTracker,
  ) {}

  /**
   * Sets the prefix of the timing metrics, so scans and updates are reported separately.
   *
   * @param prefix - Metric prefix, e.g. `scan` or `update`.
   */
  public setMetricPrefix(prefix: string): void {
    this.metricPrefix = prefix;
  }

  /** Number of cached files. */
  public get size(): number {
    return this.entries.size;
  }

  /**
   * Returns the cached parse result for a file, parsing it only if its content
   * hash differs from the cached one.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param content - Current file text.
   * @param stamp - Stamp of the file when it was read, if known.
   * @returns The parse result and whether it was recomputed.
   */
  public update(filePath: RelPath, content: string, stamp?: FileStamp): CacheUpdateResult {
    const hash = this.timed(`${this.metricPrefix}.hash`, () => hashContent(content));
    const cached = this.entries.get(filePath);
    if (cached?.hash === hash) {
      if (stamp !== undefined && !isSameStamp(cached.stamp, stamp)) {
        this.entries.set(filePath, { ...cached, stamp });
      }
      return { parsed: cached.parsed, changed: false };
    }
    const parsed = this.timed(`${this.metricPrefix}.parse`, () => this.parse(filePath, content));
    this.entries.set(filePath, {
      filePath,
      hash,
      parsed,
      ...(stamp === undefined ? {} : { stamp }),
    });
    return { parsed, changed: true };
  }

  /**
   * Checks whether a file is cached with the given stamp, i.e. whether it can
   * be reused without reading the file.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param stamp - Current stamp of the file.
   * @returns `true` if the cached entry has the same stamp.
   */
  public isFresh(filePath: RelPath, stamp: FileStamp | undefined): boolean {
    return isSameStamp(this.entries.get(filePath)?.stamp, stamp);
  }

  /**
   * Drops every entry whose file is not in a set.
   *
   * @param filePaths - Files to keep.
   */
  public retain(filePaths: ReadonlySet<RelPath>): void {
    for (const filePath of this.entries.keys()) {
      if (!filePaths.has(filePath)) {
        this.entries.delete(filePath);
      }
    }
  }

  /**
   * Lists every entry, for persistence.
   *
   * @returns A new array with one entry per cached file.
   */
  public exportEntries(): CacheEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Replaces the cache content with previously exported entries.
   *
   * @param entries - Entries returned by {@link exportEntries}.
   */
  public importEntries(entries: readonly CacheEntry[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.filePath, entry);
    }
  }

  /**
   * Returns the cached parse result of a file without touching the disk.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The parse result, or `undefined` if the file is not cached.
   */
  public get(filePath: RelPath): ParsedFile | undefined {
    return this.entries.get(filePath)?.parsed;
  }

  /**
   * Removes a file from the cache.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns `true` if the file was cached.
   */
  public delete(filePath: RelPath): boolean {
    return this.entries.delete(filePath);
  }

  /** Removes every cached file. */
  public clear(): void {
    this.entries.clear();
  }

  /**
   * Runs an operation, timing it when a tracker is attached.
   *
   * @param name - Metric name.
   * @param operation - Work to run.
   * @returns The operation's result.
   */
  private timed<T>(name: string, operation: () => T): T {
    return this.tracker === undefined ? operation() : this.tracker.measure(name, operation);
  }

  /**
   * Lists the parse results of every cached file.
   *
   * @returns A new array with one entry per cached file.
   */
  public getAll(): ParsedFile[] {
    return [...this.entries.values()].map((entry) => entry.parsed);
  }
}
