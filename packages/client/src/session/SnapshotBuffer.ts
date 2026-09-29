import { lerpTransform, type TransformSnapshot } from '../render/transforms';

/**
 * How far behind the server remote entities are drawn, in ticks (100 ms at 60 Hz). Drawing a little
 * in the past means there is nearly always a snapshot on both sides to blend between, even when one
 * arrives late or not at all. With snapshots every 2 ticks, this tolerates two missing in a row.
 */
export const INTERPOLATION_DELAY_TICKS = 6;
/** How much history to keep, in ticks. */
const HISTORY_TICKS = 60;
/** How quickly the clock estimate follows snapshots that arrive later than usual. */
const CLOCK_DRIFT_RATE = 0.01;

/**
 * Buffers recent server snapshots and answers "where was everything at render time?".
 *
 * It also estimates the server's clock: the offset between the server tick and local time,
 * tracked from the snapshots that arrive earliest. A single delayed snapshot then doesn't pull
 * the render clock back (which would look like a stutter); the estimate only drifts down slowly.
 */
export class SnapshotBuffer {
  private readonly entries: { tick: number; transforms: TransformSnapshot }[] = [];
  private clockOffset: number | null = null;

  constructor(private readonly tickRate: number) {}

  push(tick: number, transforms: TransformSnapshot, nowMs: number): void {
    const last = this.entries.at(-1);
    if (last && tick <= last.tick) return;
    this.entries.push({ tick, transforms });
    while (this.entries.length > 2 && this.entries[0]!.tick < tick - HISTORY_TICKS) this.entries.shift();

    const offset = tick - this.localTicks(nowMs);
    if (this.clockOffset === null || offset > this.clockOffset) this.clockOffset = offset;
    else this.clockOffset += (offset - this.clockOffset) * CLOCK_DRIFT_RATE;
  }

  /** The (fractional) server tick being drawn at `nowMs`. */
  renderTick(nowMs: number): number {
    return this.localTicks(nowMs) + (this.clockOffset ?? 0) - INTERPOLATION_DELAY_TICKS;
  }

  /**
   * Entity transforms at render time, blended between the two surrounding snapshots. If the
   * buffer runs dry, entities hold their last known position rather than guessing ahead.
   */
  sample(nowMs: number): TransformSnapshot {
    const first = this.entries[0];
    if (!first) return new Map();
    const t = this.renderTick(nowMs);
    let older = first;
    let newer = this.entries.at(-1)!;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.tick >= t) {
        newer = entry;
        older = this.entries[Math.max(i - 1, 0)]!;
        break;
      }
      older = newer = entry;
    }
    const alpha = newer.tick === older.tick ? 1 : (t - older.tick) / (newer.tick - older.tick);

    const result: TransformSnapshot = new Map();
    for (const [id, to] of newer.transforms) {
      const from = older.transforms.get(id);
      result.set(id, from ? lerpTransform(from, to, alpha) : to);
    }
    return result;
  }

  private localTicks(nowMs: number): number {
    return (nowMs / 1000) * this.tickRate;
  }
}
