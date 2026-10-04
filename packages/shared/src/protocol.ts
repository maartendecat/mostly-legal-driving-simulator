import type { GameEvent, Pickup, Projectile } from './combat';
import type { SnapshotDelta } from './delta';
import type { Helicopter } from './helicopter';
import type { PlayerInput } from './input';
import { MATCH_MODES, type MatchMode, type MatchPhase, type MatchState, type PlayerScore } from './match';
import { POLICE_MODES, type PoliceMode } from './police';
import type { Car, Ped, World } from './world';

/**
 * Messages between client and server. Plain JSON for now; a compact binary encoding comes with
 * the netcode tuning step once the message shapes have settled.
 */

export const DEFAULT_SERVER_PORT = 8080;
/** The server simulates at TICK_RATE but only broadcasts every this many ticks. */
export const SNAPSHOT_EVERY_TICKS = 2;

export const MAX_NAME_LENGTH = 16;
export const MAX_ROOM_NAME_LENGTH = 24;
export const MAX_PLAYERS_PER_ROOM = 8;
/** Upper bounds for what a room's creator can ask for. */
export const MAX_TIME_LIMIT_MINUTES = 60;
export const MAX_SCORE_LIMITS: Record<MatchMode, number> = { frag: 1000, points: 1_000_000, tag: 3600 };

/** What a player chooses when creating a room. */
export interface RoomSettings {
  name: string;
  mode: MatchMode;
  /** Frags, points, or seconds as "it"; 0 for none. Omitted: the mode's default. */
  scoreLimit?: number;
  /** Match length; 0 for none. Omitted: the default. */
  timeLimitMinutes?: number;
  /** Omitted: the server's default (police and army on). */
  police?: PoliceMode;
}

/** A room as listed in the lobby. */
export interface RoomInfo {
  id: string;
  name: string;
  mode: MatchMode;
  players: number;
  maxPlayers: number;
  phase: MatchPhase;
  police: PoliceMode;
}

export interface PlayerInfo extends PlayerScore {
  pedId: number;
  name: string;
}

export interface Snapshot {
  tick: number;
  /** So entities the client predicts get ids that can't clash with the server's. */
  nextId: number;
  /** So the client predicts the same "random" choices (like respawn points) as the server. */
  rngState: number;
  itPedId: number | null;
  cars: Car[];
  peds: Ped[];
  projectiles: Projectile[];
  pickups: Pickup[];
  helicopters: Helicopter[];
}

/**
 * The most inputs the server buffers per player (one second). A network hiccup can deliver a burst
 * of inputs at once; those are still applied, one per tick. Only beyond this are old ones dropped.
 */
export const MAX_QUEUED_INPUTS = 60;

export type ClientMessage =
  /** Joins a room (the default room without `roomId`); the server creates the player's ped. */
  | { type: 'join'; name: string; roomId?: string }
  /** Creates a room and joins it straight away. */
  | { type: 'createRoom'; name: string; room: RoomSettings }
  /**
   * One tick of input, sent every client tick. `seq` increases by one per tick; the server applies
   * inputs in order, one per server tick, and reports the last applied `seq` back in `acks`.
   */
  | { type: 'input'; seq: number; input: PlayerInput }
  | { type: 'ping'; time: number };

export type ServerMessage =
  /** Sent on connecting and whenever the list changes, to connections not in a room. */
  | { type: 'rooms'; rooms: RoomInfo[] }
  | { type: 'joinFailed'; reason: string }
  | { type: 'welcome'; roomId: string; roomName: string; pedId: number; seed: number; tickRate: number; snapshotEveryTicks: number }
  /**
   * `acks` maps ped id to the `seq` of that player's last input included in this snapshot.
   * `events` are all events since the previous snapshot.
   */
  | ({ type: 'snapshot'; acks: Record<number, number>; players: PlayerInfo[]; match: MatchState; events: GameEvent[] } & Snapshot)
  /**
   * What changed since the previous snapshot or delta this client received. `players` and `match`
   * are only included when they changed.
   */
  | ({ type: 'delta'; acks: Record<number, number>; players?: PlayerInfo[]; match?: MatchState; events: GameEvent[] } & SnapshotDelta)
  | { type: 'pong'; time: number };

export function captureSnapshot(world: World): Snapshot {
  return {
    tick: world.tick,
    nextId: world.nextId,
    rngState: world.rngState,
    itPedId: world.itPedId,
    cars: [...world.cars.values()],
    peds: [...world.peds.values()],
    projectiles: [...world.projectiles.values()],
    pickups: [...world.pickups.values()],
    helicopters: [...world.helicopters.values()],
  };
}

/** Replaces the world's entities with those from a server snapshot. */
export function applySnapshot(world: World, snapshot: Snapshot): void {
  world.tick = snapshot.tick;
  world.nextId = snapshot.nextId;
  world.rngState = snapshot.rngState;
  world.itPedId = snapshot.itPedId;
  world.cars = new Map(snapshot.cars.map((car) => [car.id, car]));
  world.peds = new Map(snapshot.peds.map((ped) => [ped.id, ped]));
  world.projectiles = new Map(snapshot.projectiles.map((p) => [p.id, p]));
  world.pickups = new Map(snapshot.pickups.map((p) => [p.id, p]));
  world.helicopters = new Map((snapshot.helicopters ?? []).map((h) => [h.id, h]));
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
        weaponNext: input.weaponNext === true,
        weaponPrev: input.weaponPrev === true,
      },
    };
  }
  if (msg.type === 'join' && typeof msg.name === 'string') {
    const roomId = typeof msg.roomId === 'string' ? msg.roomId.slice(0, 64) : undefined;
    return { type: 'join', name: sanitizeName(msg.name), ...(roomId !== undefined ? { roomId } : {}) };
  }
  if (msg.type === 'createRoom' && typeof msg.name === 'string' && typeof msg.room === 'object' && msg.room !== null) {
    const room = parseRoomSettings(msg.room as Record<string, unknown>);
    return room ? { type: 'createRoom', name: sanitizeName(msg.name), room } : null;
  }
  if (msg.type === 'ping' && typeof msg.time === 'number') return { type: 'ping', time: msg.time };
  return null;
}

/** Validates room settings from a client; limits are clamped to sane ranges. Null if unusable. */
function parseRoomSettings(raw: Record<string, unknown>): RoomSettings | null {
  const mode = raw.mode as MatchMode;
  if (!MATCH_MODES.includes(mode) || typeof raw.name !== 'string') return null;
  const name = sanitizeName(raw.name, MAX_ROOM_NAME_LENGTH);
  const clamp = (value: unknown, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), max) : undefined;
  const scoreLimit = clamp(raw.scoreLimit, MAX_SCORE_LIMITS[mode]);
  const timeLimitMinutes = clamp(raw.timeLimitMinutes, MAX_TIME_LIMIT_MINUTES);
  const police = POLICE_MODES.includes(raw.police as PoliceMode) ? (raw.police as PoliceMode) : undefined;
  return {
    name,
    mode,
    ...(scoreLimit !== undefined ? { scoreLimit } : {}),
    ...(timeLimitMinutes !== undefined ? { timeLimitMinutes } : {}),
    ...(police ? { police } : {}),
  };
}

/** Strips control characters and extra whitespace and limits the length. May return ''. */
export function sanitizeName(name: string, maxLength = MAX_NAME_LENGTH): string {
  return name
    // Whitespace first, so a newline between two words still becomes a space.
    .replace(/\s+/g, ' ')
    .replace(/[\p{C}]/gu, '')
    .trim()
    .slice(0, maxLength)
    .trim();
}
