/**
 * In-memory cache of parser results keyed by file, invalidated by content hash.
 */
import { createHash } from 'node:crypto';

import type { RelPath } from '../shared';
import { parseSource } from './analyzer/parser';
import type { ParsedFile } from './analyzer/types';

/** Signature of the function used to parse a file. */
export type ParseFunction = (filePath: RelPath, content: string) => ParsedFile;

/** Outcome of feeding a file's content to the cache. */
export interface CacheUpdateResult {
  /** Parser output for the current content. */
  readonly parsed: ParsedFile;
  /** `false` when the content hash matched the cached entry and no parsing happened. */
  readonly changed: boolean;
}

/** A cached parse result together with the hash of the content it came from. */
interface CacheEntry {
  readonly hash: string;
  readonly parsed: ParsedFile;
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

  /**
   * Creates an empty cache.
   *
   * @param parse - Parser used for new or changed content (injectable for tests).
   */
  public constructor(private readonly parse: ParseFunction = parseSource) {}

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
   * @returns The parse result and whether it was recomputed.
   */
  public update(filePath: RelPath, content: string): CacheUpdateResult {
    const hash = hashContent(content);
    const cached = this.entries.get(filePath);
    if (cached?.hash === hash) {
      return { parsed: cached.parsed, changed: false };
    }
    const parsed = this.parse(filePath, content);
    this.entries.set(filePath, { hash, parsed });
    return { parsed, changed: true };
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
   * Lists the parse results of every cached file.
   *
   * @returns A new array with one entry per cached file.
   */
  public getAll(): ParsedFile[] {
    return [...this.entries.values()].map((entry) => entry.parsed);
  }
}
