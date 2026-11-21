/**
 * Rebuilds full snapshots from the chunked `graph/init` messages.
 */
import type { GraphInitMessage, GraphSnapshot, WireGraphChunk } from '../shared';
import { decodeSnapshot } from '../shared';

/** Parts received so far for one snapshot. */
interface PendingSnapshot {
  readonly version: number;
  readonly chunks: WireGraphChunk[];
}

/**
 * Collects the parts of a snapshot in order. A part that does not continue
 * the current sequence (wrong index or version) discards it, and the next
 * part with index 0 starts a new one, so an interrupted transfer never
 * produces a partial graph.
 */
export class SnapshotAssembler {
  private pending: PendingSnapshot | null = null;

  /**
   * Accepts one part.
   *
   * @param message - A `graph/init` message.
   * @returns The complete snapshot when `message` is its last part, otherwise `null`.
   */
  public accept(message: GraphInitMessage): GraphSnapshot | null {
    if (message.index === 0) {
      this.pending = { version: message.version, chunks: [] };
    }
    const pending = this.pending;
    if (pending?.version !== message.version || pending.chunks.length !== message.index) {
      this.pending = null;
      return null;
    }
    pending.chunks.push(message.chunk);
    if (!message.last) {
      return null;
    }
    this.pending = null;
    return decodeSnapshot(pending.version, pending.chunks);
  }
}
