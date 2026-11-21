/**
 * Lightweight performance instrumentation: named stages with aggregated
 * durations and sizes, plus a Markdown report.
 *
 * @remarks Independent of the VS Code API and of the webview, so the same
 * tracker is used by the extension, the benchmarks and the stress tests.
 */

/** Unit of a recorded metric. */
export type MetricUnit = 'ms' | 'bytes' | 'count';

/** Aggregated values of one metric. */
export interface MetricStats {
  readonly unit: MetricUnit;
  /** Number of recorded samples. */
  readonly count: number;
  /** Sum of all samples. */
  readonly total: number;
  /** Largest sample. */
  readonly max: number;
  /** Most recent sample. */
  readonly last: number;
}

/** Source of monotonic timestamps in milliseconds. */
export type Clock = () => number;

/** Default clock: high-resolution, monotonic time. */
const defaultClock: Clock = () => performance.now();

/** Collects named metrics; cheap enough to stay enabled in production. */
export class PerformanceTracker {
  private readonly metrics = new Map<string, MetricStats>();

  /**
   * Creates an empty tracker.
   *
   * @param clock - Time source (injectable for deterministic tests).
   */
  public constructor(private readonly clock: Clock = defaultClock) {}

  /**
   * Records one sample of a metric.
   *
   * @param name - Metric name, e.g. `scan.parse`.
   * @param value - Sample value.
   * @param unit - Unit of the value (must stay the same for a given name).
   */
  public record(name: string, value: number, unit: MetricUnit = 'ms'): void {
    const previous = this.metrics.get(name);
    this.metrics.set(name, {
      unit,
      count: (previous?.count ?? 0) + 1,
      total: (previous?.total ?? 0) + value,
      max: Math.max(previous?.max ?? Number.NEGATIVE_INFINITY, value),
      last: value,
    });
  }

  /**
   * Times a synchronous operation.
   *
   * @param name - Metric name.
   * @param operation - Work to time.
   * @returns The operation's result.
   */
  public measure<T>(name: string, operation: () => T): T {
    const startedAt = this.clock();
    try {
      return operation();
    } finally {
      this.record(name, this.clock() - startedAt);
    }
  }

  /**
   * Times an asynchronous operation (wall-clock time until it settles).
   *
   * @param name - Metric name.
   * @param operation - Work to time.
   * @returns The operation's result.
   */
  public async measureAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = this.clock();
    try {
      return await operation();
    } finally {
      this.record(name, this.clock() - startedAt);
    }
  }

  /**
   * Returns the aggregated value of one metric.
   *
   * @param name - Metric name.
   * @returns The stats, or `undefined` if never recorded.
   */
  public get(name: string): MetricStats | undefined {
    return this.metrics.get(name);
  }

  /**
   * Returns every metric, sorted by name.
   *
   * @returns A new array of `[name, stats]` pairs.
   */
  public entries(): [string, MetricStats][] {
    return [...this.metrics.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  /**
   * Removes the metrics whose name starts with a prefix (all metrics if omitted).
   *
   * @param prefix - Name prefix, e.g. `scan.` to reset only scan metrics.
   */
  public reset(prefix = ''): void {
    for (const name of [...this.metrics.keys()]) {
      if (name.startsWith(prefix)) {
        this.metrics.delete(name);
      }
    }
  }
}

/**
 * Formats a metric value with its unit for humans.
 *
 * @param value - Raw value.
 * @param unit - Unit of the value.
 * @returns E.g. `12.3 ms`, `1.4 s`, `512.0 KB`, `42`.
 */
export function formatMetricValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'ms':
      return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
    case 'bytes':
      return value >= 1024 * 1024
        ? `${(value / (1024 * 1024)).toFixed(1)} MB`
        : `${(value / 1024).toFixed(1)} KB`;
    case 'count':
      return String(Math.round(value));
  }
}

/**
 * Renders the metrics of a tracker as a Markdown table.
 *
 * @param title - Report heading.
 * @param tracker - Tracker to report.
 * @returns Markdown text.
 */
export function formatPerformanceReport(title: string, tracker: PerformanceTracker): string {
  const rows = tracker.entries().map(([name, stats]) => {
    const average = stats.count === 0 ? 0 : stats.total / stats.count;
    return `| \`${name}\` | ${String(stats.count)} | ${formatMetricValue(stats.last, stats.unit)} | ${formatMetricValue(average, stats.unit)} | ${formatMetricValue(stats.max, stats.unit)} | ${formatMetricValue(stats.total, stats.unit)} |`;
  });
  if (rows.length === 0) {
    return `# ${title}\n\nNo metrics recorded yet. Open the graph first.\n`;
  }
  return [
    `# ${title}`,
    '',
    '| Metric | Samples | Last | Average | Max | Total |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}
