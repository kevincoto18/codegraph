/**
 * Small statistics and formatting helpers for benchmark reports.
 */

/** Distribution summary of a list of samples. */
export interface Summary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

/**
 * Returns the value at a percentile using nearest-rank on sorted samples.
 *
 * @param sorted - Samples sorted ascending (non-empty).
 * @param percent - Percentile in `[0, 100]`.
 * @returns The percentile value.
 */
export function percentile(sorted: readonly number[], percent: number): number {
  const rank = Math.max(Math.ceil((percent / 100) * sorted.length) - 1, 0);
  return sorted[Math.min(rank, sorted.length - 1)] ?? Number.NaN;
}

/**
 * Summarizes a list of samples.
 *
 * @param values - Samples (any order).
 * @returns The summary (all `NaN` for an empty list).
 */
export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: sorted.length === 0 ? Number.NaN : total / sorted.length,
  };
}

/**
 * Formats milliseconds for reports.
 *
 * @param ms - Duration, or `undefined`/`NaN` for missing values.
 * @returns E.g. `85 ms`, `1.24 s`, or `—`.
 */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) {
    return '—';
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
}

/**
 * Formats a byte count for reports.
 *
 * @param bytes - Size in bytes.
 * @returns E.g. `512 KB` or `3.4 MB`.
 */
export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * Formats an integer with thousands separators.
 *
 * @param value - Number to format.
 * @returns E.g. `12,345`.
 */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Renders a Markdown table.
 *
 * @param headers - Column titles.
 * @param rows - Cell values, one array per row.
 * @returns Markdown text.
 */
export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const separator = headers.map((_, index) => (index === 0 ? '---' : '---:'));
  return [headers, separator, ...rows].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}
