/**
 * Measures how well the graph of a sample project matches its ground truth
 * (`expected.json` next to the sample): precision and recall of functions,
 * imports and calls, recall by call category, and every missing or
 * unexpected connection.
 *
 * Usage: node scripts/run.mjs scripts/eval-sample.ts <sample folder> [--out report.md]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { GraphService } from '../src/extension/graphService';
import type { Expected } from './lib/graphQuality';
import { buildReport } from './lib/graphQuality';
import { FileSystemReader, quietLogger } from './lib/readers';

/**
 * Entry point.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const sample = args.find((arg, index) => !arg.startsWith('--') && index !== outIndex + 1);
  if (sample === undefined) {
    console.error(
      'Usage: node scripts/run.mjs scripts/eval-sample.ts <sample folder> [--out report.md]',
    );
    process.exit(1);
  }
  const folder = resolve(sample);
  const expected = JSON.parse(await readFile(join(folder, 'expected.json'), 'utf8')) as Expected;
  const service = new GraphService(new FileSystemReader(folder), quietLogger, undefined, {
    maxFiles: Number.POSITIVE_INFINITY,
  });
  const snapshot = await service.initialize();
  await service.dispose();
  const report = buildReport(sample, expected, snapshot);
  if (out !== undefined) {
    await writeFile(out, report, 'utf8');
  }
  console.log(report);
}

void main();
