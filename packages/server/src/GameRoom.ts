import { WebSocket } from 'ws';
import { forClients, viewFor, visibleEvents, visibleSnapshot } from './interest';
import {
  MAX_NAME_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  MAX_QUEUED_INPUTS,
  Match,
  NO_INPUT,
  SNAPSHOT_EVERY_TICKS,
  TICK_RATE,
  captureSnapshot,
  createWorld,
  encodeDelta,
  generateCity,
  quantizeSnapshot,
  removePed,
  spawnPed,
  stepWorld,
  type GameEvent,
  type MatchSettings,
  type PlayerInfo,
  type PlayerInput,
  type RoomInfo,
  type ServerMessage,
  type Snapshot,
  type World,
} from '@game/shared';

export interface GameRoomOptions {
  id: string;
  name: string;
  seed: number;
  match: MatchSettings;
  /** Permanent rooms stay open when empty; rooms players create are closed when nobody's left. */
  permanent: boolean;
  /** Traffic cars driving around the city. */
  traffic: number;
  /** Pedestrians walking around the city. */
  pedestrians: number;
  /** Members of each gang hanging around on their turf. */
  gangMembers: number;
  /** Cops on patrol. */
  cops: number;
}

export interface Player {
  socket: WebSocket;
  name: string;
  pedId: number;
  /** Inputs received but not yet applied, oldest first. */
  queue: { seq: number; input: PlayerInput }[];
  /** The input applied last tick; repeated if the queue runs dry (late or lost packets). */
  input: PlayerInput;
  /** `seq` of the last input applied, reported back to the client for reconciliation. */
  ack: number;
  /** What this player was last sent: their next delta is made against it. */
  lastSent: Snapshot | null;
  lastPlayers: string;
  lastMatch: string;
}

/**
 * One game: its own city, match and players. Owns the only real copy of its world, applies player
 * inputs and broadcasts snapshots. Clients never say where they are, only which keys are down.
 */
export class GameRoom {
  readonly world: World;
  readonly match: Match;
  private readonly players = new Set<Player>();
  private joinCount = 0;
  /** Events since the last snapshot; snapshots go out every few ticks, events happen every tick. */
  private pendingEvents: GameEvent[] = [];
  /** World tick at which the room last became empty, or null while anyone's in it. */
  private emptySince: number | null;

  constructor(readonly options: GameRoomOptions) {
    this.world = createWorld(generateCity(options.seed), options.seed, {
      traffic: options.traffic,
      pedestrians: options.pedestrians,
      gangMembers: options.gangMembers,
      cops: options.cops,
    });
    this.match = new Match(options.match, this.world);
    this.emptySince = this.world.tick;
  }

  get id(): string {
    return this.options.id;
  }

  get playerCount(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS_PER_ROOM;
  }

  /** Ticks this room has been empty for (0 while anyone's in it). */
  get emptyTicks(): number {
    return this.emptySince === null ? 0 : this.world.tick - this.emptySince;
  }

  info(): RoomInfo {
    return {
      id: this.id,
      name: this.options.name,
      mode: this.match.state.mode,
      players: this.players.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      phase: this.match.state.phase,
    };
  }

  join(socket: WebSocket, requestedName: string): Player {
    this.joinCount++;
    const ped = spawnPed(this.world);
    const player: Player = {
      socket,
      name: this.uniqueName(requestedName || `Player ${this.joinCount}`),
      pedId: ped.id,
      queue: [],
      input: { ...NO_INPUT },
      ack: 0,
      lastSent: null,
      lastPlayers: '',
      lastMatch: '',
    };
    this.players.add(player);
    this.emptySince = null;
    this.match.addPlayer(this.world, ped.id);
    send(socket, {
      type: 'welcome',
      roomId: this.id,
      roomName: this.options.name,
      pedId: ped.id,
      seed: this.options.seed,
      tickRate: TICK_RATE,
      snapshotEveryTicks: SNAPSHOT_EVERY_TICKS,
    });
    // A full snapshot straight away; from then on they get deltas against it.
    this.sendTo(player, quantizeSnapshot(forClients(captureSnapshot(this.world))), [], this.extras());
    return player;
  }

  leave(player: Player): void {
    if (!this.players.delete(player)) return;
    this.match.removePlayer(this.world, player.pedId);
    removePed(this.world, player.pedId);
    if (this.players.size === 0) this.emptySince = this.world.tick;
  }

  receiveInput(player: Player, seq: number, input: PlayerInput): void {
    const newest = player.queue.at(-1)?.seq ?? player.ack;
    if (seq <= newest) return; // duplicate or out of order
    player.queue.push({ seq, input });
    if (player.queue.length > MAX_QUEUED_INPUTS) player.queue.shift();
  }

  tick(): void {
    const inputs = new Map<number, PlayerInput>();
    // Between matches everyone is frozen; inputs are still consumed (and acked) as usual.
    const frozen = this.match.state.phase === 'intermission';
    for (const player of this.players) {
      const next = player.queue.shift();
      if (next) {
        player.input = next.input;
        player.ack = next.seq;
      }
      inputs.set(player.pedId, frozen ? NO_INPUT : player.input);
    }
    stepWorld(this.world, inputs);
    this.match.update(this.world);
    this.pendingEvents.push(...this.world.events);

    if (this.world.tick % SNAPSHOT_EVERY_TICKS === 0 && this.players.size > 0) this.broadcast();
    else if (this.players.size === 0) this.pendingEvents = [];
  }

  /** Sends every player what changed around them since the last time. */
  private broadcast(): void {
    const full = quantizeSnapshot(forClients(captureSnapshot(this.world)));
    const extras = this.extras();
    for (const player of this.players) this.sendTo(player, full, this.pendingEvents, extras);
    this.pendingEvents = [];
  }

  /**
   * Sends one player their part of the world (see interest.ts): a full snapshot the first time,
   * deltas against what they were sent before after that.
   */
  private sendTo(player: Player, full: Snapshot, events: readonly GameEvent[], extras: ReturnType<GameRoom['extras']>): void {
    if (player.socket.readyState !== WebSocket.OPEN) return;
    const view = viewFor(this.world, player.pedId);
    const snapshot = visibleSnapshot(full, view, extras.playerPeds);
    const visible = visibleEvents(events, view, extras.playerPeds, player.pedId);
    const { acks, players, match } = extras;
    const playersJson = JSON.stringify(players);
    const matchJson = JSON.stringify(match);
    const message: ServerMessage = player.lastSent
      ? {
          type: 'delta',
          ...encodeDelta(player.lastSent, snapshot),
          acks,
          events: visible,
          ...(playersJson !== player.lastPlayers ? { players } : {}),
          ...(matchJson !== player.lastMatch ? { match } : {}),
        }
      : { type: 'snapshot', ...snapshot, acks, players, match, events: visible };
    player.socket.send(JSON.stringify(message));
    player.lastSent = snapshot;
    player.lastPlayers = playersJson;
    player.lastMatch = matchJson;
  }

  /** Appends " 2", " 3", ... if another player in this room already uses this name. */
  private uniqueName(name: string): string {
    const taken = new Set([...this.players].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** The parts of a snapshot message that aren't world state, the same for every player. */
  private extras() {
    const acks: Record<number, number> = {};
    const players: PlayerInfo[] = [];
    for (const player of this.players) {
      acks[player.pedId] = player.ack;
      const score = this.match.scores.get(player.pedId) ?? { frags: 0, deaths: 0, points: 0, itTicks: 0 };
      players.push({ pedId: player.pedId, name: player.name, ...score });
    }
    return { acks, players, match: this.match.state, playerPeds: new Set(players.map((p) => p.pedId)) };
  }
}

export function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
