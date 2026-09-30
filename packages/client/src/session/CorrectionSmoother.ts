import { wrapAngle } from '@game/shared';
import type { Transform, TransformSnapshot } from '../render/transforms';

/** How quickly a correction fades: after this many seconds, about a third of it is left. */
const CORRECTION_TIME = 0.1;
/** Moves bigger than this (in blocks) are real jumps, like respawning: shown at once, not smoothed. */
const MAX_SMOOTHED_DISTANCE = 2;
/** Corrections smaller than this are dropped. */
const EPSILON = 1e-4;

/**
 * Hides prediction corrections. When the server's state shows our prediction was a bit off, the
 * predicted position jumps; instead we keep drawing where we were and let the difference fade out
 * over a few frames, so our car glides into place rather than snapping.
 */
export class CorrectionSmoother {
  private readonly offsets = new Map<number, Transform>();

  /**
   * Records that entity `id` moved from `before` to `after` because of a correction. Returns false
   * if it's a real jump that won't be smoothed.
   */
  corrected(id: number, before: Transform, after: Transform): boolean {
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    if (Math.hypot(dx, dy) > MAX_SMOOTHED_DISTANCE) {
      this.offsets.delete(id);
      return false;
    }
    const offset = this.offsets.get(id) ?? { x: 0, y: 0, heading: 0 };
    offset.x += dx;
    offset.y += dy;
    offset.heading = wrapAngle(offset.heading + wrapAngle(before.heading - after.heading));
    this.offsets.set(id, offset);
    return true;
  }

  /** Adds what's left of each correction to the transforms, then lets the corrections fade. */
  apply(transforms: TransformSnapshot, dt: number): void {
    const keep = Math.exp(-dt / CORRECTION_TIME);
    for (const [id, offset] of this.offsets) {
      const transform = transforms.get(id);
      if (transform) {
        transforms.set(id, { x: transform.x + offset.x, y: transform.y + offset.y, heading: transform.heading + offset.heading });
      }
      offset.x *= keep;
      offset.y *= keep;
      offset.heading *= keep;
      if (Math.abs(offset.x) < EPSILON && Math.abs(offset.y) < EPSILON && Math.abs(offset.heading) < EPSILON) this.offsets.delete(id);
    }
  }
}
