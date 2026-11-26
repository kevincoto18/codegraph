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
import type { GraphSnapshot } from '../src/shared';
import { FileSystemReader, quietLogger } from './lib/readers';
import { markdownTable } from './lib/stats';

/** Ground truth of a sample (see `samples/python-showcase/README.md`). */
interface Expected {
  /** Function qualified names, by file. */
  readonly functions: Readonly<Record<string, readonly string[]>>;
  /** Imported project files, by importing file. */
  readonly imports: Readonly<Record<string, readonly string[]>>;
  /** `[callee id, category]` pairs, by caller id (a function, or a file for module-level code). */
  readonly calls: Readonly<Record<string, readonly (readonly [string, string])[]>>;
}

/** Comparison of an expected and an actual set. */
interface SetScore {
  readonly expected: number;
  readonly found: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/** Separator of the two ends of a connection key. */
const ARROW = ' → ';

/**
 * Compares two sets of keys.
 *
 * @param expected - Ground truth.
 * @param actual - What the graph has.
 * @returns Counts and differences.
 */
function compare(expected: ReadonlySet<string>, actual: ReadonlySet<string>): SetScore {
  const missing = [...expected].filter((key) => !actual.has(key)).sort();
  const extra = [...actual].filter((key) => !expected.has(key)).sort();
  return { expected: expected.size, found: expected.size - missing.length, missing, extra };
}

/**
 * Formats a ratio as a percentage.
 *
 * @param part - Numerator.
 * @param whole - Denominator.
 * @returns E.g. `87.5 %`, or `—` when the denominator is 0.
 */
function percent(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)} %`;
}

/**
 * Summary row of a comparison.
 *
 * @param label - What is compared.
 * @param score - Comparison.
 * @returns Table cells.
 */
function scoreRow(label: string, score: SetScore): string[] {
  const reported = score.found + score.extra.length;
  return [
    label,
    String(score.expected),
    String(score.found),
    String(score.missing.length),
    String(score.extra.length),
    percent(score.found, reported),
    percent(score.found, score.expected),
  ];
}

/**
 * Removes the `~n` suffix that tells apart functions with the same name.
 *
 * @param id - Node id.
 * @returns The id without occurrence suffix.
 */
function baseId(id: string): string {
  return id.replace(/~\d+$/, '');
}

/**
 * Builds the report.
 *
 * @param sample - Sample folder (for the title).
 * @param expected - Ground truth.
 * @param snapshot - Graph built from the sample.
 * @returns The Markdown report.
 */
function buildReport(sample: string, expected: Expected, snapshot: GraphSnapshot): string {
  const expectedFunctions = new Set(
    Object.entries(expected.functions).flatMap(([file, names]) =>
      names.map((name) => `${file}#${name}`),
    ),
  );
  const functionNodes = snapshot.nodes.filter((node) => node.kind === 'function');
  const actualFunctions = new Set(functionNodes.map((node) => baseId(node.id)));
  const duplicates = functionNodes.filter((node) => /~\d+$/.test(node.id)).map((node) => node.id);

  const expectedImports = new Set(
    Object.entries(expected.imports).flatMap(([file, targets]) =>
      targets.map((target) => `${file}${ARROW}${target}`),
    ),
  );
  const actualImports = new Set(
    snapshot.edges
      .filter((edge) => edge.kind === 'import')
      .map((edge) => `${edge.source}${ARROW}${edge.target}`),
  );

  const categoryOf = new Map<string, string>();
  for (const [source, targets] of Object.entries(expected.calls)) {
    for (const [target, category] of targets) {
      categoryOf.set(`${source}${ARROW}${target}`, category);
    }
  }
  const actualCalls = new Set(
    snapshot.edges
      .filter((edge) => edge.kind === 'call')
      .map((edge) => `${baseId(edge.source)}${ARROW}${baseId(edge.target)}`),
  );

  const functions = compare(expectedFunctions, actualFunctions);
  const imports = compare(expectedImports, actualImports);
  const calls = compare(new Set(categoryOf.keys()), actualCalls);

  const byCategory = new Map<string, { total: number; found: number }>();
  for (const [key, category] of categoryOf) {
    const entry = byCategory.get(category) ?? { total: 0, found: 0 };
    entry.total += 1;
    entry.found += actualCalls.has(key) ? 1 : 0;
    byCategory.set(category, entry);
  }
  const categoryRows = [...byCategory]
    .sort(
      ([a, x], [b, y]) =>
        x.found / x.total - y.found / y.total || y.total - x.total || a.localeCompare(b),
    )
    .map(([category, { total, found }]) => [
      `\`${category}\``,
      String(total),
      String(found),
      percent(found, total),
    ]);

  const missingByCategory = new Map<string, string[]>();
  for (const key of calls.missing) {
    const category = categoryOf.get(key) ?? '?';
    missingByCategory.set(category, [...(missingByCategory.get(category) ?? []), key]);
  }

  /**
   * Formats keys as a Markdown list.
   *
   * @param keys - Connection or node keys.
   * @returns The list, or a placeholder when empty.
   */
  const list = (keys: readonly string[]): string =>
    keys.length === 0 ? '_None._' : keys.map((key) => `- \`${key}\``).join('\n');

  return [
    `# Graph quality — ${sample}`,
    '',
    `${String(snapshot.nodes.filter((node) => node.kind === 'file').length)} files, ` +
      `${String(functionNodes.length)} functions, ${String(snapshot.edges.length)} edges in the graph.`,
    '',
    markdownTable(
      ['', 'Expected', 'Found', 'Missing', 'Unexpected', 'Precision', 'Recall'],
      [scoreRow('Functions', functions), scoreRow('Imports', imports), scoreRow('Calls', calls)],
    ),
    '',
    '## Calls by category',
    '',
    markdownTable(['Category', 'Expected', 'Found', 'Recall'], categoryRows),
    '',
    '## Missing calls',
    '',
    ...[...missingByCategory]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([category, keys]) => [`### \`${category}\``, '', list(keys), '']),
    '## Unexpected calls (false positives)',
    '',
    list(calls.extra),
    '',
    '## Imports',
    '',
    '**Missing**',
    '',
    list(imports.missing),
    '',
    '**Unexpected**',
    '',
    list(imports.extra),
    '',
    '## Functions',
    '',
    '**Missing**',
    '',
    list(functions.missing),
    '',
    '**Unexpected**',
    '',
    list(functions.extra),
    '',
    '**Duplicated ids** (same qualified name twice in a file)',
    '',
    list(duplicates),
    '',
  ].join('\n');
}

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
