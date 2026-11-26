import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { GraphService } from '../src/extension/graphService';
import type { Evaluation, Expected } from './lib/graphQuality';
import { evaluateGraph, precisionOf, recallOf } from './lib/graphQuality';
import { FileSystemReader, quietLogger } from './lib/readers';

/** Sample whose ground truth guards the quality of the Python graph. */
const PYTHON_SHOWCASE = resolve('samples/python-showcase');

let evaluation: Evaluation;

beforeAll(async () => {
  const expected = JSON.parse(
    await readFile(join(PYTHON_SHOWCASE, 'expected.json'), 'utf8'),
  ) as Expected;
  const service = new GraphService(new FileSystemReader(PYTHON_SHOWCASE), quietLogger);
  const snapshot = await service.initialize();
  await service.dispose();
  evaluation = evaluateGraph(expected, snapshot);
}, 60_000);

describe('Python graph quality (samples/python-showcase)', () => {
  it('finds every function, once', () => {
    expect(evaluation.functions.missing).toEqual([]);
    expect(evaluation.functions.extra).toEqual([]);
    expect(evaluation.duplicates).toEqual([]);
  });

  it('never reports a call that does not exist', () => {
    expect(evaluation.calls.extra).toEqual([]);
    expect(precisionOf(evaluation.calls)).toBe(1);
  });

  it('never reports an import that does not exist', () => {
    expect(evaluation.imports.extra).toEqual([]);
  });

  it('keeps import and call recall at least at the current level', () => {
    // Raise these thresholds whenever the analyzer improves.
    expect(recallOf(evaluation.imports)).toBe(1);
    expect(recallOf(evaluation.calls)).toBeGreaterThanOrEqual(0.99);
  });
});
