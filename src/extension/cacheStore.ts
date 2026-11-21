/**
 * Persistence of the parse cache between VS Code sessions.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deserialize, serialize } from 'node:v8';

import type { CacheEntry } from './cache';

/** Port that loads and saves cache entries. */
export interface CacheStore {
  /**
   * Loads the saved entries.
   *
   * @returns The entries, or an empty array if nothing valid was saved.
   */
  load(): Promise<CacheEntry[]>;
  /**
   * Saves entries, replacing the previous content.
   *
   * @param entries - Entries to save.
   */
  save(entries: readonly CacheEntry[]): Promise<void>;
}

/** Shape of the persisted file. */
interface PersistedCache {
  /** Compatibility key; a mismatch discards the file. */
  readonly key: string;
  readonly entries: readonly CacheEntry[];
}

/** Logging surface used by the store. */
interface StoreLogger {
  /** Logs a recoverable problem. */
  warn(message: string): void;
}

/**
 * Checks that a deserialized value has the persisted cache shape and key.
 *
 * @param value - Deserialized value.
 * @param key - Expected compatibility key.
 * @returns `true` if the value can be used.
 */
export function isPersistedCache(value: unknown, key: string): value is PersistedCache {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<PersistedCache>;
  return candidate.key === key && Array.isArray(candidate.entries);
}

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
 * Stores the cache in a single binary file (V8 serialization: fast and
 * compact, no dependency). The file is written atomically (temp file +
 * rename) and is ignored when its compatibility key differs, e.g. after a
 * parser or extension update.
 */
export class FileCacheStore implements CacheStore {
  /**
   * Creates the store.
   *
   * @param filePath - Absolute path of the cache file.
   * @param key - Compatibility key (schema, parser and extension versions).
   * @param logger - Destination of warnings.
   */
  public constructor(
    private readonly filePath: string,
    private readonly key: string,
    private readonly logger: StoreLogger,
  ) {}

  /**
   * Loads the saved entries.
   *
   * @returns The entries, or an empty array if the file is missing, corrupt or outdated.
   */
  public async load(): Promise<CacheEntry[]> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch {
      return []; // No cache yet.
    }
    try {
      const value: unknown = deserialize(bytes);
      return isPersistedCache(value, this.key) ? [...value.entries] : [];
    } catch (error) {
      this.logger.warn(`Ignoring unreadable parse cache: ${describeError(error)}`);
      return [];
    }
  }

  /**
   * Saves entries atomically.
   *
   * @param entries - Entries to save.
   */
  public async save(entries: readonly CacheEntry[]): Promise<void> {
    const persisted: PersistedCache = { key: this.key, entries };
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, serialize(persisted));
    await rename(temporaryPath, this.filePath);
  }
}
