/**
 * Persistence of the parse cache and of the last graph between VS Code sessions.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deserialize, serialize } from 'node:v8';

import type { GraphSnapshot, WireGraphChunk } from '../shared';
import { decodeSnapshot, encodeSnapshot } from '../shared';
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

/** Port that loads and saves the last graph, shown instantly on the next session. */
export interface GraphStore {
  /**
   * Loads the saved graph.
   *
   * @returns The graph, or `null` if nothing valid was saved.
   */
  load(): Promise<GraphSnapshot | null>;
  /**
   * Saves a graph, replacing the previous one.
   *
   * @param snapshot - Graph to save.
   */
  save(snapshot: GraphSnapshot): Promise<void>;
}

/** Shape of the persisted cache file. */
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

/** Shape of the persisted graph file (compact wire chunks). */
interface PersistedGraph {
  readonly key: string;
  readonly version: number;
  readonly chunks: readonly WireGraphChunk[];
}

/**
 * Checks that a deserialized value has the persisted graph shape and key.
 *
 * @param value - Deserialized value.
 * @param key - Expected compatibility key.
 * @returns `true` if the value can be used.
 */
export function isPersistedGraph(value: unknown, key: string): value is PersistedGraph {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<PersistedGraph>;
  return (
    candidate.key === key &&
    typeof candidate.version === 'number' &&
    Number.isInteger(candidate.version) &&
    candidate.version >= 1 &&
    Array.isArray(candidate.chunks)
  );
}

/**
 * Reads and deserializes a persisted file.
 *
 * @param filePath - Absolute path.
 * @param label - Name used in warnings.
 * @param logger - Destination of warnings.
 * @returns The deserialized value, or `undefined` if the file is missing or corrupt.
 */
async function readSerialized(
  filePath: string,
  label: string,
  logger: StoreLogger,
): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    return undefined; // Nothing saved yet.
  }
  try {
    return deserialize(bytes);
  } catch (error) {
    logger.warn(`Ignoring unreadable ${label}: ${describeError(error)}`);
    return undefined;
  }
}

/**
 * Serializes a value and writes it atomically (temp file + rename).
 *
 * @param filePath - Absolute path.
 * @param value - Value to persist.
 */
async function writeSerialized(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(temporaryPath, serialize(value));
  await rename(temporaryPath, filePath);
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
    const value = await readSerialized(this.filePath, 'parse cache', this.logger);
    return isPersistedCache(value, this.key) ? [...value.entries] : [];
  }

  /**
   * Saves entries atomically.
   *
   * @param entries - Entries to save.
   */
  public async save(entries: readonly CacheEntry[]): Promise<void> {
    const persisted: PersistedCache = { key: this.key, entries };
    await writeSerialized(this.filePath, persisted);
  }
}

/**
 * Stores the last graph in a single binary file, in the compact wire format,
 * so the next session can show it before the workspace has been rescanned.
 */
export class FileGraphStore implements GraphStore {
  /**
   * Creates the store.
   *
   * @param filePath - Absolute path of the graph file.
   * @param key - Compatibility key (schema, parser and extension versions).
   * @param logger - Destination of warnings.
   */
  public constructor(
    private readonly filePath: string,
    private readonly key: string,
    private readonly logger: StoreLogger,
  ) {}

  /**
   * Loads the saved graph.
   *
   * @returns The graph, or `null` if the file is missing, corrupt or outdated.
   */
  public async load(): Promise<GraphSnapshot | null> {
    const value = await readSerialized(this.filePath, 'saved graph', this.logger);
    return isPersistedGraph(value, this.key) ? decodeSnapshot(value.version, value.chunks) : null;
  }

  /**
   * Saves a graph atomically.
   *
   * @param snapshot - Graph to save.
   */
  public async save(snapshot: GraphSnapshot): Promise<void> {
    const persisted: PersistedGraph = {
      key: this.key,
      version: snapshot.version,
      chunks: encodeSnapshot(snapshot),
    };
    await writeSerialized(this.filePath, persisted);
  }
}
