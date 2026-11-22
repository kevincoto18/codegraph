/**
 * Entry point of the parser worker bundle (`dist/parseWorker.js`): parses
 * batches of files sent by a {@link WorkerParsePool} on a separate thread.
 */
import { parentPort } from 'node:worker_threads';

import { parseFile } from './analyzer/analyzers';
import type { ParseRequest, ParseResponse } from './parsePool';

parentPort?.on('message', (request: ParseRequest) => {
  const response: ParseResponse = {
    id: request.id,
    results: request.jobs.map((job) => parseFile(job.filePath, job.content)),
  };
  parentPort?.postMessage(response);
});
