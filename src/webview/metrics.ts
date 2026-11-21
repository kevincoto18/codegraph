/**
 * Batches performance samples measured in the webview and sends them to the
 * extension host, which adds them to the performance report.
 */
import type { MetricSample } from '../shared';
import { MAX_METRIC_SAMPLES } from '../shared';
import { postToHost } from './vscodeApi';

/** Delay before buffered samples are sent, in milliseconds. */
const FLUSH_DELAY_MS = 500;

/** Bounded buffer of samples waiting to be sent. */
export class MetricsBuffer {
  private samples: MetricSample[] = [];

  /**
   * Creates an empty buffer.
   *
   * @param capacity - Maximum buffered samples; the oldest are dropped first.
   */
  public constructor(private readonly capacity: number = MAX_METRIC_SAMPLES) {}

  /** Number of buffered samples. */
  public get size(): number {
    return this.samples.length;
  }

  /**
   * Adds a sample, dropping the oldest one when the buffer is full.
   *
   * @param name - Metric name.
   * @param value - Duration in milliseconds.
   */
  public add(name: string, value: number): void {
    this.samples.push({ name, value });
    if (this.samples.length > this.capacity) {
      this.samples.shift();
    }
  }

  /**
   * Returns and clears the buffered samples.
   *
   * @returns The samples, oldest first.
   */
  public drain(): MetricSample[] {
    const drained = this.samples;
    this.samples = [];
    return drained;
  }
}

/** Shared buffer of the webview. */
const buffer = new MetricsBuffer();

/** Pending flush timer, if any. */
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Records a webview performance sample; samples are sent to the host in batches.
 *
 * @param name - Metric name (the host prefixes it with `webview.`).
 * @param value - Duration in milliseconds.
 */
export function reportMetric(name: string, value: number): void {
  buffer.add(name, value);
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    const samples = buffer.drain();
    if (samples.length > 0) {
      postToHost({ type: 'metrics', samples });
    }
  }, FLUSH_DELAY_MS);
}
