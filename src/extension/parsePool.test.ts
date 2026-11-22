import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ParsedFile } from './analyzer/types';
import { WorkerParsePool, chooseWorkerCount, createParsePool } from './parsePool';

/** Worker that answers like the real one, with a recognizable fake result. */
const FAKE_WORKER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, jobs }) => {
  parentPort.postMessage({
    id,
    results: jobs.map((job) => ({ filePath: job.filePath, imports: [], functions: [], exports: [{ exportedName: 'worker', localName: job.content }] })),
  });
});
`;

/**
 * Parser used by the calling thread in the tests.
 *
 * @param filePath - File path.
 * @param content - File content.
 * @returns A recognizable fake result.
 */
function parseInline(filePath: string, content: string): ParsedFile {
  return {
    filePath,
    imports: [],
    functions: [],
    exports: [{ exportedName: 'inline', localName: content }],
  };
}

describe('chooseWorkerCount', () => {
  it('uses one worker per spare core, up to four', () => {
    expect(chooseWorkerCount(1)).toBe(0);
    expect(chooseWorkerCount(2)).toBe(1);
    expect(chooseWorkerCount(16)).toBe(4);
  });

  it('creates no pool on single-core machines', () => {
    expect(createParsePool('unused.js', parseInline, 1)).toBeNull();
  });
});

describe('WorkerParsePool', () => {
  let directory = '';
  let workerPath = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'codegraph-pool-'));
    workerPath = join(directory, 'worker.cjs');
    await writeFile(workerPath, FAKE_WORKER);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('parses every file in order, on the workers and the calling thread', async () => {
    const pool = new WorkerParsePool(workerPath, 2, parseInline);
    const jobs = Array.from({ length: 1000 }, (_, index) => ({
      filePath: `f${String(index)}.ts`,
      content: String(index),
    }));
    const results = await pool.parseAll(jobs);
    await pool.dispose();

    expect(results.map((result) => result.filePath)).toEqual(jobs.map((job) => job.filePath));
    expect(results.map((result) => result.exports[0]?.localName)).toEqual(
      jobs.map((job) => job.content),
    );
    const parsedBy = new Set(results.map((result) => result.exports[0]?.exportedName));
    expect(parsedBy).toEqual(new Set(['worker', 'inline']));
  });

  it('rejects when a worker fails', async () => {
    const brokenPath = join(directory, 'broken.cjs');
    await writeFile(
      brokenPath,
      "require('node:worker_threads').parentPort.on('message', () => { throw new Error('boom'); });",
    );
    const pool = new WorkerParsePool(brokenPath, 1, parseInline);
    const jobs = Array.from({ length: 300 }, (_, index) => ({
      filePath: `${String(index)}.ts`,
      content: '',
    }));
    await expect(pool.parseAll(jobs)).rejects.toThrow('boom');
    await pool.dispose();
  });
});
