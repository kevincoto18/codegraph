/**
 * Host stress test: runs the real GraphService (parser, cache, linker, diff)
 * on synthetic projects of increasing size, without VS Code.
 *
 * Scenarios per size: cold scan, repeated scans, message size, a burst of
 * saves, renaming a hub export, deleting a whole folder, and retained memory.
 *
 * Usage: npm run stress [-- --sizes S,M,L,XL]
 */
import { GraphService } from '../src/extension/graphService';
import { PerformanceTracker } from '../src/extension/perf';
import type { GraphPatch, GraphSnapshot } from '../src/shared';
import type { GeneratedProject } from './lib/generateProject';
import { generateProject } from './lib/generateProject';
import {
  FileSystemReader,
  collectGarbage,
  quietLogger,
  saveReport,
  stressProjectDir,
  writeProject,
} from './lib/readers';
import type { StressSize } from './lib/sizes';
import { parseSizes, readFlag } from './lib/sizes';
import type { Summary } from './lib/stats';
import { formatBytes, formatCount, formatMs, markdownTable, summarize } from './lib/stats';

/** Number of rapid saves in the burst scenario. */
const BURST_SIZE = 200;

/** Repeated scans used to measure warmed-up (JIT) scan time. */
const REPEATED_SCANS = 2;

/** Extra scans used to detect retained memory (leaks). */
const LEAK_SCANS = 3;

/** Results of one size. */
interface SizeResult {
  readonly size: string;
  readonly files: number;
  readonly functions: number;
  readonly nodes: number;
  readonly edges: number;
  readonly generateMs: number;
  readonly writeMs: number;
  readonly coldScan: Record<string, number>;
  readonly repeatedScanMs: Summary;
  readonly initMessageBytes: number;
  readonly initSerializeMs: number;
  readonly burst: {
    readonly totalMs: number;
    readonly latency: Summary;
    readonly patchBytes: Summary;
  };
  readonly hubRename: {
    readonly ms: number;
    readonly removedEdges: number;
    readonly upsertedNodes: number;
  };
  readonly folderDelete: {
    readonly files: number;
    readonly totalMs: number;
    readonly perFile: Summary;
  };
  readonly memory: {
    readonly heapAfterScanMb: number;
    readonly rssMb: number;
    readonly heapGrowthMb: number | null;
  };
}

/**
 * Converts bytes to megabytes.
 *
 * @param bytes - Byte count.
 * @returns Megabytes.
 */
function toMb(bytes: number): number {
  return bytes / (1024 * 1024);
}

/**
 * Reads the stage totals of the last scan from a tracker.
 *
 * @param tracker - Tracker of the service.
 * @returns Total milliseconds per scan stage.
 */
function scanStages(tracker: PerformanceTracker): Record<string, number> {
  const stages: Record<string, number> = {};
  for (const name of [
    'scan.list',
    'scan.read',
    'scan.hash',
    'scan.parse',
    'scan.link',
    'scan.total',
  ]) {
    stages[name.slice('scan.'.length)] = tracker.get(name)?.total ?? Number.NaN;
  }
  return stages;
}

/**
 * Measures the serialized size of a message.
 *
 * @param message - Message to serialize.
 * @returns Size in bytes and serialization time.
 */
function measureMessage(message: unknown): { bytes: number; ms: number } {
  const startedAt = performance.now();
  const json = JSON.stringify(message);
  return { bytes: Buffer.byteLength(json, 'utf8'), ms: performance.now() - startedAt };
}

/**
 * Lists the regular (non-hub, non-barrel) files of a generated project.
 *
 * @param project - Generated project.
 * @returns Paths of ordinary source files.
 */
function ordinaryFiles(project: GeneratedProject): string[] {
  return [...project.files.keys()].filter(
    (path) => !path.startsWith('shared/') && !path.endsWith('/index.ts'),
  );
}

/**
 * Runs the burst scenario: many saves fired back to back.
 *
 * @param service - Initialized service.
 * @param reader - Its reader (edits go to the overlay).
 * @param project - Generated project.
 * @returns Total time, per-update latency and patch sizes.
 */
async function runBurst(
  service: GraphService,
  reader: FileSystemReader,
  project: GeneratedProject,
): Promise<SizeResult['burst']> {
  const targets = ordinaryFiles(project)
    .filter((_, index) => index % 3 === 0)
    .slice(0, BURST_SIZE);
  for (const [index, path] of targets.entries()) {
    reader.overlay.set(
      path,
      `${project.files.get(path) ?? ''}\nfunction burst${String(index)}(input) {\n  return input;\n}\n`,
    );
  }
  const latencies: number[] = [];
  const patchBytes: number[] = [];
  const startedAt = performance.now();
  await Promise.all(
    targets.map(async (path) => {
      const patch = await service.updateFile(path);
      latencies.push(performance.now() - startedAt);
      if (patch !== null) {
        patchBytes.push(measureMessage({ type: 'graph/patch', patch }).bytes);
      }
    }),
  );
  const totalMs = performance.now() - startedAt;
  // Latency of each update = completion time minus the previous completion (queue is serialized).
  const sorted = [...latencies].sort((a, b) => a - b);
  const perUpdate = sorted.map((value, index) => value - (sorted[index - 1] ?? 0));
  return { totalMs, latency: summarize(perUpdate), patchBytes: summarize(patchBytes) };
}

/**
 * Runs the hub-rename scenario: renames an export imported by a large share of the project.
 *
 * @param service - Initialized service.
 * @param reader - Its reader.
 * @param project - Generated project.
 * @returns Time and size of the resulting patch.
 */
async function runHubRename(
  service: GraphService,
  reader: FileSystemReader,
  project: GeneratedProject,
): Promise<SizeResult['hubRename']> {
  const hub = project.hubFiles[0] ?? 'shared/hub0.ts';
  const content = project.files.get(hub) ?? '';
  reader.overlay.set(hub, content.replace(/hub0Fn0\b/g, 'hub0Fn0Renamed'));
  const startedAt = performance.now();
  const patch: GraphPatch | null = await service.updateFile(hub);
  return {
    ms: performance.now() - startedAt,
    removedEdges: patch?.removeEdgeIds.length ?? 0,
    upsertedNodes: patch?.upsertNodes.length ?? 0,
  };
}

/**
 * Runs the folder-delete scenario: removes every file of the first package's first area.
 *
 * @param service - Initialized service.
 * @param reader - Its reader.
 * @param project - Generated project.
 * @returns Number of removed files, total and per-file time.
 */
async function runFolderDelete(
  service: GraphService,
  reader: FileSystemReader,
  project: GeneratedProject,
): Promise<SizeResult['folderDelete']> {
  const root = `${project.packageRoots[0] ?? 'packages/pkg0'}/src/`;
  const victims = [...project.files.keys()].filter((path) => path.startsWith(root)).slice(0, 1000);
  const perFile: number[] = [];
  const startedAt = performance.now();
  for (const path of victims) {
    reader.overlay.set(path, null);
    const fileStart = performance.now();
    await service.removeFile(path);
    perFile.push(performance.now() - fileStart);
  }
  return {
    files: victims.length,
    totalMs: performance.now() - startedAt,
    perFile: summarize(perFile),
  };
}

/**
 * Runs every scenario for one size.
 *
 * @param size - Size preset.
 * @param seed - Generator seed.
 * @returns The results.
 */
async function runSize(size: StressSize, seed: number): Promise<SizeResult> {
  console.log(`\n▶ ${size.id}: generating ${formatCount(size.files)} files…`);
  let startedAt = performance.now();
  const project = generateProject({ files: size.files, seed });
  const generateMs = performance.now() - startedAt;
  const folder = stressProjectDir(size.id);
  startedAt = performance.now();
  await writeProject(project.files, folder);
  const writeMs = performance.now() - startedAt;

  collectGarbage();
  const tracker = new PerformanceTracker();
  const reader = new FileSystemReader(folder);
  const service = new GraphService(reader, quietLogger, undefined, {
    maxFiles: Number.POSITIVE_INFINITY,
    tracker,
  });

  console.log('  cold scan…');
  const snapshot: GraphSnapshot = await service.initialize();
  const coldScan = scanStages(tracker);
  collectGarbage();
  const heapAfterScan = process.memoryUsage();

  const init = measureMessage({ type: 'graph/init', graph: snapshot });

  console.log('  repeated scans…');
  const repeated: number[] = [];
  for (let run = 0; run < REPEATED_SCANS; run += 1) {
    await service.initialize();
    repeated.push(tracker.get('scan.total')?.last ?? Number.NaN);
  }

  console.log(`  burst of ${String(BURST_SIZE)} saves…`);
  const burst = await runBurst(service, reader, project);
  console.log('  hub rename…');
  const hubRename = await runHubRename(service, reader, project);
  console.log('  folder delete…');
  const folderDelete = await runFolderDelete(service, reader, project);

  console.log('  leak check…');
  reader.overlay.clear();
  let heapGrowthMb: number | null = null;
  if (collectGarbage()) {
    await service.initialize();
    collectGarbage();
    const baseline = process.memoryUsage().heapUsed;
    for (let run = 0; run < LEAK_SCANS; run += 1) {
      await service.initialize();
    }
    collectGarbage();
    heapGrowthMb = toMb(process.memoryUsage().heapUsed - baseline);
  }

  return {
    size: size.id,
    files: snapshot.nodes.filter((node) => node.kind === 'file').length,
    functions: project.functionCount,
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
    generateMs,
    writeMs,
    coldScan,
    repeatedScanMs: summarize(repeated),
    initMessageBytes: init.bytes,
    initSerializeMs: init.ms,
    burst,
    hubRename,
    folderDelete,
    memory: {
      heapAfterScanMb: toMb(heapAfterScan.heapUsed),
      rssMb: toMb(heapAfterScan.rss),
      heapGrowthMb,
    },
  };
}

/**
 * Renders the results as Markdown.
 *
 * @param results - Results of every size.
 * @returns The report.
 */
function renderReport(results: readonly SizeResult[]): string {
  const sizes = results.map((result) => result.size);
  /**
   * Builds a table row with one cell per size.
   *
   * @param label - Row label.
   * @param cell - Formats the cell of one size.
   * @returns The row cells.
   */
  const row = (label: string, cell: (result: SizeResult) => string): string[] => [
    label,
    ...results.map(cell),
  ];
  return [
    '# CodeGraph — host stress test',
    '',
    `Node ${process.version} · ${process.platform}/${process.arch} · ${new Date().toISOString()}`,
    '',
    '## Project',
    '',
    markdownTable(
      ['', ...sizes],
      [
        row('Files analyzed', (r) => formatCount(r.files)),
        row('Functions', (r) => formatCount(r.functions)),
        row('Nodes / edges', (r) => `${formatCount(r.nodes)} / ${formatCount(r.edges)}`),
      ],
    ),
    '',
    '## Cold scan (per stage)',
    '',
    markdownTable(
      ['Stage', ...sizes],
      [
        row('List files', (r) => formatMs(r.coldScan.list)),
        row('Read files', (r) => formatMs(r.coldScan.read)),
        row('Hash (sum)', (r) => formatMs(r.coldScan.hash)),
        row('Parse (sum)', (r) => formatMs(r.coldScan.parse)),
        row('Link', (r) => formatMs(r.coldScan.link)),
        row('**Total**', (r) => `**${formatMs(r.coldScan.total)}**`),
        row('Repeated scan (p50, JIT warm)', (r) => formatMs(r.repeatedScanMs.p50)),
      ],
    ),
    '',
    '## Messages',
    '',
    markdownTable(
      ['', ...sizes],
      [
        row('`graph/init` size', (r) => formatBytes(r.initMessageBytes)),
        row('`graph/init` serialize', (r) => formatMs(r.initSerializeMs)),
        row(
          'Patch size (p50 / max)',
          (r) => `${formatBytes(r.burst.patchBytes.p50)} / ${formatBytes(r.burst.patchBytes.max)}`,
        ),
      ],
    ),
    '',
    '## Live updates',
    '',
    markdownTable(
      ['Scenario', ...sizes],
      [
        row(`Burst of ${String(BURST_SIZE)} saves — total`, (r) => formatMs(r.burst.totalMs)),
        row(
          'Per save (p50 / p95 / max)',
          (r) =>
            `${formatMs(r.burst.latency.p50)} / ${formatMs(r.burst.latency.p95)} / ${formatMs(r.burst.latency.max)}`,
        ),
        row(
          'Rename hub export',
          (r) => `${formatMs(r.hubRename.ms)} (−${formatCount(r.hubRename.removedEdges)} edges)`,
        ),
        row('Delete folder — files', (r) => formatCount(r.folderDelete.files)),
        row('Delete folder — total', (r) => formatMs(r.folderDelete.totalMs)),
        row('Delete folder — per file (p50)', (r) => formatMs(r.folderDelete.perFile.p50)),
      ],
    ),
    '',
    '## Memory',
    '',
    markdownTable(
      ['', ...sizes],
      [
        row('Heap after scan', (r) => `${r.memory.heapAfterScanMb.toFixed(0)} MB`),
        row('RSS after scan', (r) => `${r.memory.rssMb.toFixed(0)} MB`),
        row(`Heap growth after ${String(LEAK_SCANS)} rescans`, (r) =>
          r.memory.heapGrowthMb === null ? '—' : `${r.memory.heapGrowthMb.toFixed(1)} MB`,
        ),
      ],
    ),
    '',
  ].join('\n');
}

/** Runs the stress test for the selected sizes and saves the report. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sizes = parseSizes(readFlag(args, 'sizes'), ['S', 'M', 'L']);
  const seed = Number(readFlag(args, 'seed') ?? 42);
  const results: SizeResult[] = [];
  for (const size of sizes) {
    results.push(await runSize(size, seed));
  }
  const report = renderReport(results);
  console.log(`\n${report}`);
  const paths = await saveReport('stress', report, results);
  console.log(`Saved ${paths.markdownPath} and ${paths.jsonPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
