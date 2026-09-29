import type { PlayerInput } from './input';
import type { Car, Ped, World } from './world';

/**
 * Messages between client and server. Plain JSON for now; a compact binary encoding comes with
 * the netcode tuning step once the message shapes have settled.
 */

export const DEFAULT_SERVER_PORT = 8080;
/** The server simulates at TICK_RATE but only broadcasts every this many ticks. */
export const SNAPSHOT_EVERY_TICKS = 2;

export interface Snapshot {
  tick: number;
  cars: Car[];
  peds: Ped[];
}

/**
 * The most inputs the server buffers per player (one second). A network hiccup can deliver a burst
 * of inputs at once; those are still applied, one per tick. Only beyond this are old ones dropped.
 */
export const MAX_QUEUED_INPUTS = 60;

export type ClientMessage =
  /**
   * One tick of input, sent every client tick. `seq` increases by one per tick; the server applies
   * inputs in order, one per server tick, and reports the last applied `seq` back in `acks`.
   */
  | { type: 'input'; seq: number; input: PlayerInput }
  | { type: 'ping'; time: number };

export type ServerMessage =
  | { type: 'welcome'; pedId: number; seed: number; tickRate: number; snapshotEveryTicks: number }
  /** `acks` maps ped id to the `seq` of that player's last input included in this snapshot. */
  | ({ type: 'snapshot'; acks: Record<number, number> } & Snapshot)
  | { type: 'pong'; time: number };

export function captureSnapshot(world: World): Snapshot {
  return {
    tick: world.tick,
    cars: [...world.cars.values()],
    peds: [...world.peds.values()],
  };
}

/** Replaces the world's entities with those from a server snapshot. */
export function applySnapshot(world: World, snapshot: Snapshot): void {
  world.tick = snapshot.tick;
  world.cars = new Map(snapshot.cars.map((car) => [car.id, car]));
  world.peds = new Map(snapshot.peds.map((ped) => [ped.id, ped]));
}

/** Parses an untrusted client message, returning null if it's malformed. */
export function parseClientMessage(data: string): ClientMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (msg.type === 'input' && Number.isSafeInteger(msg.seq) && typeof msg.input === 'object' && msg.input !== null) {
    const input = msg.input as Record<string, unknown>;
    return {
      type: 'input',
      seq: msg.seq as number,
      input: {
        up: input.up === true,
        down: input.down === true,
        left: input.left === true,
        right: input.right === true,
        fire: input.fire === true,
        handbrake: input.handbrake === true,
        enter: input.enter === true,
      },
    };
  }
  if (msg.type === 'ping' && typeof msg.time === 'number') return { type: 'ping', time: msg.time };
  return null;
}
