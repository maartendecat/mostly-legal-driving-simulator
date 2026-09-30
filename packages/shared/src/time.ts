/** Simulation ticks per second, on both server and client. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICK_RATE);
}
