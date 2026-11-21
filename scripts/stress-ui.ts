/**
 * UI stress test: drives the real, built webview in a headless browser with
 * graphs of increasing size, without VS Code.
 *
 * Uses the Edge or Chrome already installed on the machine (playwright-core,
 * no browser download). Set CODEGRAPH_BROWSER to an executable path to force one.
 *
 * Usage: npm run build && npm run stress:ui [-- --sizes S,M,L,XL]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';

import { GraphService } from '../src/extension/graphService';
import type { GraphPatch, GraphSnapshot, MetricSample } from '../src/shared';
import { createGraphInitMessages } from '../src/shared';
import { generateProject } from './lib/generateProject';
import { MemoryReader, quietLogger, saveReport } from './lib/readers';
import type { StressSize } from './lib/sizes';
import { parseSizes, readFlag } from './lib/sizes';
import { formatCount, formatMs, markdownTable, summarize } from './lib/stats';
import type { HarnessData } from './lib/uiHarness';
import { startHarness } from './lib/uiHarness';

/** Maximum time for one heavy UI action before it counts as a failure. */
const ACTION_TIMEOUT_MS = 120_000;

/** Duration of each FPS measurement. */
const FPS_WINDOW_MS = 2_000;

/** Viewport of the headless browser. */
const VIEWPORT = { width: 1600, height: 900 };

/** Helpers installed in the page by the harness (see `lib/uiHarness.ts`). */
interface HarnessWindow {
  readonly __sent: readonly { readonly type: string; readonly samples?: readonly MetricSample[] }[];
  readonly __t: { readonly firstPaint?: number };
  /** Average FPS over a time window. */
  __fps(durationMs: number): Promise<number>;
  /** Clicks a toolbar button and waits for a UI state; -1 on timeout. */
  __clickAndWait(label: string, predicate: string, timeoutMs: number): Promise<number>;
  /** Posts a patch and waits until the toolbar shows the expected text; -1 on timeout. */
  __patchLatency(patch: unknown, expectedText: string, timeoutMs: number): Promise<number>;
  /** Types into the search box and returns the latency of each keystroke. */
  __typeLatency(text: string, timeoutMs: number): Promise<number[]>;
}

/** Results of one size (milliseconds unless stated; -1 = timed out, null = skipped). */
interface UiResult {
  size: string;
  files: number;
  functions: number;
  firstPaintMs: number;
  patchMs: number | null;
  searchKeystrokeMs: number | null;
  fpsIdle: number | null;
  fpsPanCollapsed: number | null;
  fpsZoomCollapsed: number | null;
  expandAllMs: number | null;
  fpsPanExpanded: number | null;
  collapseAllMs: number | null;
  relayoutMs: number | null;
  heapMb: number | null;
  webviewMetrics: Record<string, number>;
}

/**
 * Launches a headless Chromium-based browser installed on the machine.
 *
 * @returns The browser and a label describing which one was used.
 * @throws Error if neither CODEGRAPH_BROWSER, Edge nor Chrome can be launched.
 */
async function launchBrowser(): Promise<{ browser: Browser; label: string }> {
  const args = ['--enable-precise-memory-info'];
  const executablePath = process.env.CODEGRAPH_BROWSER;
  if (executablePath !== undefined && executablePath !== '') {
    return { browser: await chromium.launch({ executablePath, args }), label: executablePath };
  }
  const failures: string[] = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return { browser: await chromium.launch({ channel, args }), label: channel };
    } catch (error) {
      failures.push(
        `${channel}: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`,
      );
    }
  }
  throw new Error(
    `No browser found. Install Edge/Chrome or set CODEGRAPH_BROWSER.\n${failures.join('\n')}`,
  );
}

/**
 * Builds the snapshot and a single-function patch for a generated project.
 *
 * @param size - Size preset.
 * @returns Snapshot, patch and expected toolbar text after the patch.
 */
async function prepareGraph(
  size: StressSize,
): Promise<{ snapshot: GraphSnapshot; patch: GraphPatch; functions: number }> {
  const project = generateProject({ files: size.files, seed: 42 });
  const files = new Map(project.files);
  const service = new GraphService(new MemoryReader(files), quietLogger, undefined, {
    maxFiles: Number.POSITIVE_INFINITY,
  });
  const snapshot = await service.initialize();
  const target = [...files.keys()].find(
    (path) => path.startsWith('packages/') && path.endsWith('.ts') && !path.endsWith('index.ts'),
  );
  if (target === undefined) {
    throw new Error('No file to patch.');
  }
  files.set(
    target,
    `${files.get(target) ?? ''}\nexport function stressPatched(): number {\n  return 1;\n}\n`,
  );
  const patch = await service.updateFile(target);
  if (patch === null) {
    throw new Error('The patch scenario produced no change.');
  }
  return { snapshot, patch, functions: project.functionCount };
}

/**
 * Measures frames per second while dragging the canvas.
 *
 * @param page - Browser page.
 * @returns Average FPS during the drag.
 */
async function measurePanFps(page: Page): Promise<number> {
  const fps = page.evaluate(
    (ms) => (globalThis as unknown as HarnessWindow).__fps(ms),
    FPS_WINDOW_MS,
  );
  const centerX = VIEWPORT.width / 2;
  const centerY = VIEWPORT.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  const steps = 40;
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    await page.mouse.move(centerX + Math.cos(angle) * 300, centerY + Math.sin(angle) * 200);
    await page.waitForTimeout(FPS_WINDOW_MS / steps);
  }
  await page.mouse.up();
  return fps;
}

/**
 * Measures frames per second while zooming in and out with the wheel.
 *
 * @param page - Browser page.
 * @returns Average FPS during the zoom.
 */
async function measureZoomFps(page: Page): Promise<number> {
  const fps = page.evaluate(
    (ms) => (globalThis as unknown as HarnessWindow).__fps(ms),
    FPS_WINDOW_MS,
  );
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  const steps = 40;
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, step < steps / 2 ? -120 : 120);
    await page.waitForTimeout(FPS_WINDOW_MS / steps);
  }
  return fps;
}

/**
 * Clicks a toolbar button and waits until the UI reaches a state.
 *
 * @param page - Browser page.
 * @param label - Button text.
 * @param predicate - `collapsed`, `expanded` or `any`.
 * @returns Milliseconds until done, or -1 on timeout.
 */
async function clickAndWait(page: Page, label: string, predicate: string): Promise<number> {
  return page.evaluate(
    ([buttonLabel, state, timeout]) =>
      (globalThis as unknown as HarnessWindow).__clickAndWait(buttonLabel, state, timeout),
    [label, predicate, ACTION_TIMEOUT_MS] as const,
  );
}

/**
 * Collects the webview's own metrics (`metrics` messages) as medians.
 *
 * @param page - Browser page.
 * @returns Median value per metric name.
 */
async function collectWebviewMetrics(page: Page): Promise<Record<string, number>> {
  await page.waitForTimeout(700); // metrics are flushed every 500 ms
  const sent = await page.evaluate(() => (globalThis as unknown as HarnessWindow).__sent);
  const byName = new Map<string, number[]>();
  for (const message of sent) {
    for (const sample of message.type === 'metrics' ? (message.samples ?? []) : []) {
      byName.set(sample.name, [...(byName.get(sample.name) ?? []), sample.value]);
    }
  }
  return Object.fromEntries([...byName].map(([name, values]) => [name, summarize(values).p50]));
}

/**
 * Runs every UI scenario for one size.
 *
 * @param browser - Browser to use.
 * @param url - Harness URL.
 * @param data - Harness data (updated for this size).
 * @param size - Size preset.
 * @returns The results.
 */
async function runSize(
  browser: Browser,
  url: string,
  data: HarnessData,
  size: StressSize,
): Promise<UiResult> {
  console.log(`\n▶ ${size.id}: preparing graph (${formatCount(size.files)} files)…`);
  const { snapshot, patch, functions } = await prepareGraph(size);
  data.initMessagesJson = JSON.stringify(createGraphInitMessages(snapshot));
  const files = snapshot.nodes.filter((node) => node.kind === 'file').length;

  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const result: UiResult = {
    size: size.id,
    files,
    functions,
    firstPaintMs: -1,
    patchMs: null,
    searchKeystrokeMs: null,
    fpsIdle: null,
    fpsPanCollapsed: null,
    fpsZoomCollapsed: null,
    expandAllMs: null,
    fpsPanExpanded: null,
    collapseAllMs: null,
    relayoutMs: null,
    heapMb: null,
    webviewMetrics: {},
  };
  try {
    await page.goto(`${url}?collapse=always`);
    const firstPaintMs = await attempt(
      'first paint',
      async () => {
        await page.waitForFunction(
          () => (globalThis as unknown as HarnessWindow).__t.firstPaint !== undefined,
        );
        return page.evaluate(() => (globalThis as unknown as HarnessWindow).__t.firstPaint ?? -1);
      },
      -1,
    );
    result.firstPaintMs = firstPaintMs;
    console.log(`  first paint ${formatAction(firstPaintMs)}`);
    if (firstPaintMs < 0) {
      console.log('  the graph never rendered — skipping the remaining scenarios');
      return result;
    }

    result.patchMs = await attempt(
      'patch',
      () =>
        page.evaluate(
          ([p, text, timeout]) =>
            (globalThis as unknown as HarnessWindow).__patchLatency(p, text, timeout),
          [patch, `${String(functions + 1)} functions`, ACTION_TIMEOUT_MS] as const,
        ),
      -1,
    );
    const keystrokes = await attempt(
      'search',
      () =>
        page.evaluate(
          (timeout) => (globalThis as unknown as HarnessWindow).__typeLatency('f12', timeout),
          ACTION_TIMEOUT_MS,
        ),
      [],
    );
    result.searchKeystrokeMs = keystrokes.length === 0 ? null : summarize(keystrokes).p50;
    await attempt('clear search', () => page.fill('.cg-search__input', ''), undefined);

    result.fpsIdle = await attempt(
      'idle fps',
      () =>
        page.evaluate((ms) => (globalThis as unknown as HarnessWindow).__fps(ms), FPS_WINDOW_MS),
      null,
    );
    result.fpsPanCollapsed = await attempt('pan fps', () => measurePanFps(page), null);
    result.fpsZoomCollapsed = await attempt('zoom fps', () => measureZoomFps(page), null);
    console.log(
      `  collapsed: pan ${formatFps(result.fpsPanCollapsed)}, zoom ${formatFps(result.fpsZoomCollapsed)}`,
    );

    console.log('  expand all…');
    result.expandAllMs = await attempt(
      'expand all',
      () => clickAndWait(page, 'Expand all', 'expanded'),
      -1,
    );
    if (result.expandAllMs >= 0) {
      result.fpsPanExpanded = await attempt('pan fps (expanded)', () => measurePanFps(page), null);
      result.collapseAllMs = await attempt(
        'collapse all',
        () => clickAndWait(page, 'Collapse all', 'collapsed'),
        -1,
      );
      result.relayoutMs = await attempt(
        're-layout',
        () => clickAndWait(page, 'Re-layout', 'any'),
        -1,
      );
    } else {
      console.log('  expand all failed — skipping expanded scenarios');
    }

    result.heapMb = await attempt(
      'heap',
      async () => {
        const heap = await page.evaluate(
          () =>
            (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? null,
        );
        return heap === null ? null : heap / (1024 * 1024);
      },
      null,
    );
    result.webviewMetrics = await attempt('webview metrics', () => collectWebviewMetrics(page), {});
    return result;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Runs a scenario step, turning failures and timeouts into a fallback value
 * so one slow scenario never aborts the whole run.
 *
 * @param label - Step name (for the log).
 * @param operation - Step to run.
 * @param fallback - Value returned on failure.
 * @returns The step's result, or the fallback.
 */
async function attempt<T>(label: string, operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.log(
      `  ${label} failed: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`,
    );
    return fallback;
  }
}

/**
 * Formats an FPS value.
 *
 * @param value - FPS, or `null` if skipped/failed.
 * @returns Display text.
 */
function formatFps(value: number | null): string {
  return value === null ? 'skipped' : `${value.toFixed(0)} fps`;
}

/**
 * Formats a duration that may have timed out (-1) or been skipped (null).
 *
 * @param ms - Duration.
 * @returns Display text.
 */
function formatAction(ms: number | null): string {
  if (ms === null) {
    return 'skipped';
  }
  return ms < 0 ? `timeout (>${formatMs(ACTION_TIMEOUT_MS)})` : formatMs(ms);
}

/**
 * Renders the results as Markdown.
 *
 * @param results - Results of every size.
 * @param browserLabel - Browser used.
 * @returns The report.
 */
function renderReport(results: readonly UiResult[], browserLabel: string): string {
  const sizes = results.map((result) => result.size);
  /**
   * Builds a table row with one cell per size.
   *
   * @param label - Row label.
   * @param cell - Formats the cell of one size.
   * @returns The row cells.
   */
  const row = (label: string, cell: (result: UiResult) => string): string[] => [
    label,
    ...results.map(cell),
  ];
  return [
    '# CodeGraph — UI stress test',
    '',
    `Browser: ${browserLabel} (headless) · viewport ${String(VIEWPORT.width)}×${String(VIEWPORT.height)} · ${new Date().toISOString()}`,
    '',
    '> Headless browsers often render without GPU acceleration: FPS here is a lower bound of what VS Code shows.',
    '',
    markdownTable(
      ['Scenario', ...sizes],
      [
        row('Files / functions', (r) => `${formatCount(r.files)} / ${formatCount(r.functions)}`),
        row('First paint (collapsed)', (r) => formatAction(r.firstPaintMs)),
        row('Live patch → painted', (r) => formatAction(r.patchMs)),
        row('Search keystroke (p50)', (r) =>
          r.searchKeystrokeMs === null ? 'skipped' : formatMs(r.searchKeystrokeMs),
        ),
        row('Idle FPS', (r) => formatFps(r.fpsIdle)),
        row('Pan FPS (collapsed)', (r) => formatFps(r.fpsPanCollapsed)),
        row('Zoom FPS (collapsed)', (r) => formatFps(r.fpsZoomCollapsed)),
        row('Expand all', (r) => formatAction(r.expandAllMs)),
        row('Pan FPS (expanded)', (r) => formatFps(r.fpsPanExpanded)),
        row('Collapse all', (r) => formatAction(r.collapseAllMs)),
        row('Re-layout', (r) => formatAction(r.relayoutMs)),
        row('JS heap', (r) => (r.heapMb === null ? '—' : `${r.heapMb.toFixed(0)} MB`)),
        row('webview `layout.full` (p50)', (r) => formatMs(r.webviewMetrics['layout.full'])),
        row('webview `layout.incremental` (p50)', (r) =>
          formatMs(r.webviewMetrics['layout.incremental']),
        ),
        row('webview `render.first`', (r) => formatMs(r.webviewMetrics['render.first'])),
      ],
    ),
    '',
  ].join('\n');
}

/** Runs the UI stress test for the selected sizes and saves the report. */
async function main(): Promise<void> {
  const webviewDist = resolve('dist', 'webview');
  if (!existsSync(resolve(webviewDist, 'index.js'))) {
    throw new Error('Webview bundle not found. Run "npm run build" first.');
  }
  const sizes = parseSizes(readFlag(process.argv.slice(2), 'sizes'), ['S', 'M', 'L']);
  const data: HarnessData = { initMessagesJson: '[]' };
  const { server, url } = await startHarness(webviewDist, data);
  const { browser, label } = await launchBrowser();
  console.log(`Browser: ${label}`);
  const results: UiResult[] = [];
  try {
    for (const size of sizes) {
      results.push(await runSize(browser, url, data, size));
    }
  } finally {
    await browser.close();
    server.close();
  }
  const report = renderReport(results, label);
  console.log(`\n${report}`);
  const paths = await saveReport('stress-ui', report, results);
  console.log(`Saved ${paths.markdownPath} and ${paths.jsonPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
