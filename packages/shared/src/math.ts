export interface Vec2 {
  x: number;
  y: number;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Wraps an angle into the range [-PI, PI]. */
export function wrapAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolates between two angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/**
 * Advances a mulberry32 PRNG stored on `holder.rngState` and returns a value in [0, 1).
 * Keeping the state as a plain number keeps the simulation serializable and deterministic.
 */
export function nextRandom(holder: { rngState: number }): number {
  holder.rngState = (holder.rngState + 0x6d2b79f5) >>> 0;
  let t = holder.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randomInt(holder: { rngState: number }, maxExclusive: number): number {
  return Math.floor(nextRandom(holder) * maxExclusive);
}

export function randomPick<T>(holder: { rngState: number }, items: readonly T[]): T {
  return items[randomInt(holder, items.length)]!;
}
