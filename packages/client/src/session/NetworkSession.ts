import {
  TICK_DT,
  NO_INPUT,
  applySnapshot,
  cloneWorld,
  createWorld,
  generateCity,
  stepWorld,
  type ClientMessage,
  type GameEvent,
  type MatchState,
  type PlayerInfo,
  type PlayerInput,
  type ServerMessage,
  type World,
} from '@game/shared';
import { captureTransforms, lerpTransform, type TransformSnapshot } from '../render/transforms';
import type { FrameState, GameSession } from './GameSession';
import { Lobby } from './Lobby';
import { SnapshotBuffer } from './SnapshotBuffer';

type Welcome = Extract<ServerMessage, { type: 'welcome' }>;
type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;

export interface ConnectOptions {
  name: string;
  /** The room to join; the server's default room if omitted. */
  roomId?: string;
  timeoutMs?: number;
  /** Artificial round-trip delay, to test how the game feels on a slow connection. */
  lagMs?: number;
}

const PING_INTERVAL_MS = 2000;

/**
 * Multiplayer session with client-side prediction.
 *
 * The server owns the world. To keep our own controls instant anyway, we run the shared simulation
 * locally on a copy ("predicted") and apply each input immediately. Every input carries a sequence
 * number; snapshots tell us the last one the server applied. When a snapshot arrives we reset the
 * prediction to the server's state and replay the inputs it hasn't seen yet (reconciliation), so
 * any mistake in our prediction is corrected within one round trip.
 *
 * Our own ped, car and projectiles are drawn from the prediction, as are pickups (so one we walk
 * over disappears at once). Everything else is drawn slightly in the past,
 * blended between buffered server snapshots (see SnapshotBuffer), so other players move smoothly
 * even when snapshots arrive unevenly.
 */
export class NetworkSession implements GameSession {
  readonly myPedId: number;
  readonly roomName: string;
  private readonly serverWorld: World;
  private predicted: World;
  private displayWorld: World;
  private pending: { seq: number; input: PlayerInput }[] = [];
  private nextSeq = 1;
  private previousPredicted: TransformSnapshot;
  private readonly snapshots: SnapshotBuffer;
  private accumulator = 0;
  private playerList: PlayerInfo[] = [];
  private matchState: MatchState | null = null;
  /** Effects of our own shots: shown as soon as the server reports them. */
  private dueEvents: GameEvent[] = [];
  /** Everyone else's: shown when the (delayed) render time reaches them, to line up with what's drawn. */
  private scheduledEvents: GameEvent[] = [];
  private pingMs: number | null = null;
  private connected = true;
  private readonly pinger: ReturnType<typeof setInterval>;

  /** Connects to a game server and joins a room in one go (the lobby screen uses Lobby directly). */
  static async connect(url: string, { name, roomId, timeoutMs, lagMs }: ConnectOptions): Promise<NetworkSession> {
    const lobby = await Lobby.open(url, { timeoutMs, lagMs });
    try {
      return await lobby.join(name, roomId);
    } catch (error) {
      lobby.close();
      throw error;
    }
  }

  /** Takes over a lobby connection once the server has welcomed us into a room. */
  static fromWelcome(socket: WebSocket, welcome: Welcome, lagMs: number): NetworkSession {
    return new NetworkSession(socket, welcome, lagMs);
  }

  private constructor(
    private readonly socket: WebSocket,
    welcome: Welcome,
    private readonly lagMs: number,
  ) {
    this.myPedId = welcome.pedId;
    this.roomName = welcome.roomName;
    this.snapshots = new SnapshotBuffer(welcome.tickRate);
    // The map is generated from the seed; entities come from snapshots.
    this.serverWorld = createWorld(generateCity(welcome.seed), welcome.seed);
    this.serverWorld.cars.clear();
    this.predicted = cloneWorld(this.serverWorld);
    this.displayWorld = this.serverWorld;
    this.previousPredicted = new Map();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      this.delayed(() => this.onMessage(message));
    });
    socket.addEventListener('close', () => this.onClose());
    this.pinger = setInterval(() => this.send({ type: 'ping', time: performance.now() }), PING_INTERVAL_MS);
    this.send({ type: 'ping', time: performance.now() });
  }

  /** Leaves the game. */
  close(): void {
    this.socket.close();
    this.onClose();
  }

  private onClose(): void {
    this.connected = false;
    clearInterval(this.pinger);
  }

  get world(): World {
    return this.displayWorld;
  }

  get players(): readonly PlayerInfo[] {
    return this.playerList;
  }

  get match(): MatchState | null {
    return this.matchState;
  }

  get status(): string {
    if (!this.connected) return 'Disconnected from server';
    const players = this.serverWorld.peds.size;
    const ping = this.pingMs === null ? '' : ` · ${Math.round(this.pingMs)} ms`;
    const lag = this.lagMs > 0 ? ` (incl. ${this.lagMs} ms simulated lag)` : '';
    return `Online · ${this.roomName} · ${players} player${players === 1 ? '' : 's'}${ping}${lag}`;
  }

  update(frameDt: number, sampleInput: () => PlayerInput): FrameState {
    this.accumulator += frameDt;
    while (this.accumulator >= TICK_DT) {
      // The server ignores input between matches; predict (and send) the same.
      const sampled = sampleInput();
      const input = this.matchState?.phase === 'intermission' ? NO_INPUT : sampled;
      const seq = this.nextSeq++;
      this.pending.push({ seq, input });
      this.send({ type: 'input', seq, input });
      this.previousPredicted = captureTransforms(this.predicted);
      stepWorld(this.predicted, new Map([[this.myPedId, input]]));
      this.accumulator -= TICK_DT;
    }

    // Everyone else: slightly in the past, blended between buffered snapshots.
    const now = performance.now();
    const transforms = this.snapshots.sample(now);
    const display: World = {
      ...this.serverWorld,
      tick: this.predicted.tick,
      peds: new Map(this.serverWorld.peds),
      cars: new Map(this.serverWorld.cars),
      projectiles: new Map([...this.serverWorld.projectiles].filter(([, p]) => p.ownerId !== this.myPedId)),
      pickups: this.predicted.pickups,
    };
    // Ourselves: blend between the last two predicted ticks.
    const alpha = this.accumulator / TICK_DT;
    const drawPredicted = (entity: { id: number; x: number; y: number; heading: number }) =>
      transforms.set(entity.id, lerpTransform(this.previousPredicted.get(entity.id) ?? entity, entity, alpha));
    for (const id of this.predictedIds()) {
      const ped = this.predicted.peds.get(id);
      const car = this.predicted.cars.get(id);
      if (ped) display.peds.set(id, ped);
      if (car) display.cars.set(id, car);
      const entity = ped ?? car;
      if (entity) drawPredicted(entity);
    }
    for (const projectile of this.predicted.projectiles.values()) {
      if (projectile.ownerId !== this.myPedId) continue;
      display.projectiles.set(projectile.id, projectile);
      drawPredicted(projectile);
    }
    this.displayWorld = display;
    return { transforms, events: this.takeEvents(this.snapshots.renderTick(now)) };
  }

  private takeEvents(renderTick: number): GameEvent[] {
    const events = this.dueEvents;
    this.dueEvents = [];
    this.scheduledEvents = this.scheduledEvents.filter((event) => {
      if (event.tick > renderTick) return true;
      events.push(event);
      return false;
    });
    return events;
  }

  /**
   * Entities drawn from our prediction: our ped plus the car we're in according to either the
   * prediction or the server, so getting in and out doesn't make the car jump between timelines.
   */
  private predictedIds(): number[] {
    const ids = [this.myPedId];
    const carIds = [this.predicted.peds.get(this.myPedId)?.carId, this.serverWorld.peds.get(this.myPedId)?.carId];
    for (const carId of carIds) {
      if (carId != null && !ids.includes(carId)) ids.push(carId);
    }
    return ids;
  }

  private onMessage(message: ServerMessage): void {
    if (message.type === 'snapshot') this.onSnapshot(message);
    else if (message.type === 'pong') this.pingMs = performance.now() - message.time;
  }

  private onSnapshot(snapshot: SnapshotMessage): void {
    applySnapshot(this.serverWorld, snapshot);
    this.snapshots.push(snapshot.tick, captureTransforms(this.serverWorld), performance.now());
    this.playerList = snapshot.players;
    this.matchState = snapshot.match;
    for (const event of snapshot.events) (event.ownerId === this.myPedId ? this.dueEvents : this.scheduledEvents).push(event);

    // Reconcile: restart the prediction from the server's state and replay unacknowledged inputs.
    const ack = snapshot.acks[this.myPedId] ?? 0;
    this.pending = this.pending.filter((p) => p.seq > ack);
    this.predicted = cloneWorld(this.serverWorld);
    for (const { input } of this.pending) stepWorld(this.predicted, new Map([[this.myPedId, input]]));
  }

  private send(message: ClientMessage): void {
    const data = JSON.stringify(message);
    this.delayed(() => {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(data);
    });
  }

  /** Runs `fn` after half the simulated lag (applied once each way), or immediately without lag. */
  private delayed(fn: () => void): void {
    if (this.lagMs > 0) setTimeout(fn, this.lagMs / 2);
    else fn();
  }
}
