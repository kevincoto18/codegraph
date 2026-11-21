/**
 * Quick, repeatable benchmark with a baseline and a regression check.
 *
 * Targets: the demo project, `node_modules/eslint/lib` (real CommonJS code)
 * and the synthetic size S. Each target is scanned cold several times and
 * the median is reported.
 *
 * Usage:
 *   npm run bench               print results
 *   npm run bench:baseline      save them as bench/baseline.json
 *   npm run bench:check         fail if a target is >20% slower than the baseline
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { GraphService } from '../src/extension/graphService';
import { PerformanceTracker } from '../src/extension/perf';
import { generateProject } from './lib/generateProject';
import {
  FileSystemReader,
  collectGarbage,
  quietLogger,
  saveReport,
  stressProjectDir,
  writeProject,
} from './lib/readers';
import { STRESS_SIZES } from './lib/sizes';
import { formatCount, formatMs, markdownTable, summarize } from './lib/stats';

/** Cold scans per target. */
const RUNS = 5;

/** Allowed slowdown before `--check` fails. */
const REGRESSION_TOLERANCE = 0.2;

/** Absolute slack (ms) that absorbs noise on very fast targets. */
const REGRESSION_SLACK_MS = 25;

/** Path of the stored baseline. */
const BASELINE_PATH = join('bench', 'baseline.json');

/** A folder to benchmark. */
interface Target {
  readonly name: string;
  readonly folder: string;
}

/** Median results of one target. */
export interface TargetResult {
  readonly name: string;
  readonly files: number;
  readonly nodes: number;
  readonly edges: number;
  /** Median milliseconds per scan stage, plus `total`. */
  readonly medianMs: Record<string, number>;
}

/** Contents of `bench/baseline.json`. */
export interface Baseline {
  readonly createdAt: string;
  readonly node: string;
  readonly platform: string;
  readonly results: readonly TargetResult[];
}

/** Scan stages reported by the benchmark. */
const STAGES = ['read', 'hash', 'parse', 'link', 'total'] as const;

/**
 * Prepares the benchmark targets (writes the synthetic project if needed).
 *
 * @returns The targets that exist on this machine.
 */
async function prepareTargets(): Promise<Target[]> {
  const targets: Target[] = [{ name: 'demo-project', folder: resolve('samples', 'demo-project') }];
  const eslintLib = resolve('node_modules', 'eslint', 'lib');
  if (existsSync(eslintLib)) {
    targets.push({ name: 'eslint/lib', folder: eslintLib });
  }
  const synthetic = stressProjectDir('bench-S');
  await writeProject(generateProject({ files: STRESS_SIZES.S.files, seed: 42 }).files, synthetic);
  targets.push({ name: 'synthetic S', folder: synthetic });
  return targets;
}

/**
 * Scans a target cold `RUNS` times and returns the medians.
 *
 * @param target - Folder to scan.
 * @returns Median stage timings and graph size.
 */
async function benchmarkTarget(target: Target): Promise<TargetResult> {
  const samples = new Map<string, number[]>(STAGES.map((stage) => [stage, []]));
  let files = 0;
  let nodes = 0;
  let edges = 0;
  for (let run = 0; run < RUNS; run += 1) {
    collectGarbage();
    const tracker = new PerformanceTracker();
    const service = new GraphService(new FileSystemReader(target.folder), quietLogger, undefined, {
      maxFiles: Number.POSITIVE_INFINITY,
      tracker,
    });
    const snapshot = await service.initialize();
    for (const stage of STAGES) {
      samples.get(stage)?.push(tracker.get(`scan.${stage}`)?.total ?? Number.NaN);
    }
    files = tracker.get('scan.files')?.last ?? 0;
    nodes = snapshot.nodes.length;
    edges = snapshot.edges.length;
  }
  const medianMs: Record<string, number> = {};
  for (const [stage, values] of samples) {
    medianMs[stage] = summarize(values).p50;
  }
  return { name: target.name, files, nodes, edges, medianMs };
}

/**
 * Renders results (and the comparison with a baseline) as Markdown.
 *
 * @param results - Current results.
 * @param baseline - Stored baseline, if any.
 * @returns The report.
 */
function renderReport(results: readonly TargetResult[], baseline: Baseline | null): string {
  const rows = results.map((result) => {
    const previous = baseline?.results.find((entry) => entry.name === result.name);
    const total = result.medianMs.total ?? Number.NaN;
    const before = previous?.medianMs.total;
    const delta =
      before === undefined ? '—' : `${(((total - before) / before) * 100).toFixed(1)} %`;
    return [
      result.name,
      formatCount(result.files),
      `${formatCount(result.nodes)} / ${formatCount(result.edges)}`,
      ...STAGES.slice(0, -1).map((stage) => formatMs(result.medianMs[stage])),
      `**${formatMs(total)}**`,
      formatMs(before),
      delta,
    ];
  });
  return [
    '# CodeGraph — benchmark',
    '',
    `Median of ${String(RUNS)} cold scans · Node ${process.version} · ${process.platform}/${process.arch}`,
    '',
    markdownTable(
      [
        'Target',
        'Files',
        'Nodes / edges',
        'Read',
        'Hash',
        'Parse',
        'Link',
        'Total',
        'Baseline',
        'Δ',
      ],
      rows,
    ),
    '',
  ].join('\n');
}

/**
 * Finds targets that regressed beyond the tolerance.
 *
 * @param results - Current results.
 * @param baseline - Stored baseline.
 * @returns Human-readable regression descriptions (empty if none).
 */
export function findRegressions(results: readonly TargetResult[], baseline: Baseline): string[] {
  const regressions: string[] = [];
  for (const result of results) {
    const before = baseline.results.find((entry) => entry.name === result.name)?.medianMs.total;
    const now = result.medianMs.total;
    if (before === undefined || now === undefined) {
      continue;
    }
    if (now > before * (1 + REGRESSION_TOLERANCE) + REGRESSION_SLACK_MS) {
      regressions.push(`${result.name}: ${formatMs(now)} vs baseline ${formatMs(before)}`);
    }
  }
  return regressions;
}

/**
 * Loads the stored baseline.
 *
 * @returns The baseline, or `null` if none was saved yet.
 */
async function loadBaseline(): Promise<Baseline | null> {
  if (!existsSync(BASELINE_PATH)) {
    return null;
  }
  return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
}

/** Runs the benchmark, then saves or checks the baseline as requested. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targets = await prepareTargets();
  const results: TargetResult[] = [];
  for (const target of targets) {
    console.log(`▶ ${target.name}…`);
    results.push(await benchmarkTarget(target));
  }
  const baseline = await loadBaseline();
  const report = renderReport(results, baseline);
  console.log(`\n${report}`);
  await saveReport('bench', report, results);

  if (args.includes('--save-baseline')) {
    const data: Baseline = {
      createdAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      results,
    };
    await writeFile(BASELINE_PATH, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Baseline saved to ${BASELINE_PATH}`);
  }

  if (args.includes('--check')) {
    if (baseline === null) {
      console.error(`No baseline found. Run "npm run bench:baseline" first.`);
      process.exit(1);
    }
    const regressions = findRegressions(results, baseline);
    if (regressions.length > 0) {
      console.error(
        `Performance regressions (> ${String(REGRESSION_TOLERANCE * 100)} %):\n- ${regressions.join('\n- ')}`,
      );
      process.exit(1);
    }
    console.log('No performance regressions.');
  }
}

if (process.argv[1]?.endsWith('bench.cjs') === true) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
