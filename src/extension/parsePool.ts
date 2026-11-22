/**
 * Parallel parsing of many files with worker threads, used by full scans.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import type { RelPath } from '../shared';
import type { ParsedFile } from './analyzer/types';
import type { ParseFunction } from './cache';

/** A file to parse. */
export interface ParseJob {
  readonly filePath: RelPath;
  readonly content: string;
}

/** Message sent to a parser worker. */
export interface ParseRequest {
  readonly id: number;
  readonly jobs: readonly ParseJob[];
}

/** Message returned by a parser worker. */
export interface ParseResponse {
  readonly id: number;
  readonly results: readonly ParsedFile[];
}

/** Parses many files, possibly in parallel. */
export interface ParsePool {
  /**
   * Parses files.
   *
   * @param jobs - Files to parse.
   * @returns Parse results, in the same order as `jobs`.
   */
  parseAll(jobs: readonly ParseJob[]): Promise<ParsedFile[]>;
  /** Stops the workers. */
  dispose(): Promise<void>;
}

/** Files sent to a worker at a time: large enough to amortize messaging. */
const CHUNK_SIZE = 64;

/** Upper bound on worker threads (each loads its own copy of the TypeScript compiler). */
const MAX_WORKERS = 4;

/**
 * Chooses how many workers to start: one per spare core, at most {@link MAX_WORKERS}.
 *
 * @param cores - Number of logical cores.
 * @returns Number of workers (0 on single-core machines).
 */
export function chooseWorkerCount(cores: number): number {
  return Math.max(0, Math.min(MAX_WORKERS, cores - 1));
}

/**
 * Parses files on worker threads while the calling thread parses too: chunks
 * are taken from a shared queue, so fast and slow threads balance out, and
 * the calling thread starts parsing right away while the workers boot.
 */
export class WorkerParsePool implements ParsePool {
  private readonly workers: Worker[] = [];
  private nextRequestId = 0;

  /**
   * Starts the workers.
   *
   * @param workerPath - Absolute path of the worker bundle.
   * @param size - Number of workers.
   * @param parseInline - Parser used by the calling thread.
   */
  public constructor(
    workerPath: string,
    size: number,
    private readonly parseInline: ParseFunction,
  ) {
    for (let index = 0; index < size; index += 1) {
      this.workers.push(new Worker(workerPath));
    }
  }

  /**
   * Parses files on every thread.
   *
   * @param jobs - Files to parse.
   * @returns Parse results, in the same order as `jobs`.
   */
  public async parseAll(jobs: readonly ParseJob[]): Promise<ParsedFile[]> {
    const results: ParsedFile[] = new Array<ParsedFile>(jobs.length);
    let nextIndex = 0;
    /**
     * Takes the next chunk of the queue.
     *
     * @returns The start index and the jobs, or `null` when the queue is empty.
     */
    const take = (): { start: number; chunk: readonly ParseJob[] } | null => {
      if (nextIndex >= jobs.length) {
        return null;
      }
      const start = nextIndex;
      nextIndex = Math.min(jobs.length, nextIndex + CHUNK_SIZE);
      return { start, chunk: jobs.slice(start, nextIndex) };
    };

    const workerLoops = this.workers.map(async (worker) => {
      for (let next = take(); next !== null; next = take()) {
        const parsed = await this.request(worker, next.chunk);
        parsed.forEach((result, offset) => {
          results[next.start + offset] = result;
        });
      }
    });
    const inlineLoop = (async () => {
      for (let next = take(); next !== null; next = take()) {
        next.chunk.forEach((job, offset) => {
          results[next.start + offset] = this.parseInline(job.filePath, job.content);
        });
        // Let worker replies be processed between chunks.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    await Promise.all([...workerLoops, inlineLoop]);
    return results;
  }

  /** Stops the workers. */
  public async dispose(): Promise<void> {
    await Promise.all(this.workers.splice(0).map((worker) => worker.terminate()));
  }

  /**
   * Sends one chunk to a worker and waits for its reply.
   *
   * @param worker - Worker to use.
   * @param jobs - Files to parse.
   * @returns The worker's results.
   */
  private request(worker: Worker, jobs: readonly ParseJob[]): Promise<readonly ParsedFile[]> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      /**
       * Resolves when the reply to this request arrives.
       *
       * @param response - Worker reply.
       */
      const onMessage = (response: ParseResponse): void => {
        if (response.id !== id) {
          return;
        }
        worker.off('message', onMessage);
        worker.off('error', onError);
        resolve(response.results);
      };
      /**
       * Rejects when the worker fails.
       *
       * @param error - Worker error.
       */
      const onError = (error: Error): void => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        reject(error);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      const request: ParseRequest = { id, jobs };
      worker.postMessage(request);
    });
  }
}

/**
 * Creates a pool sized for this machine.
 *
 * @param workerPath - Absolute path of the worker bundle.
 * @param parseInline - Parser used by the calling thread.
 * @param cores - Number of logical cores (defaults to this machine's).
 * @returns The pool, or `null` when the machine has no spare core.
 */
export function createParsePool(
  workerPath: string,
  parseInline: ParseFunction,
  cores: number = availableParallelism(),
): ParsePool | null {
  const size = chooseWorkerCount(cores);
  return size === 0 ? null : new WorkerParsePool(workerPath, size, parseInline);
}
