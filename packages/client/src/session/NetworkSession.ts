import {
  TICK_DT,
  NO_INPUT,
  applyDelta,
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
  type Projectile,
  type ServerMessage,
  type World,
} from '@game/shared';
import { captureTransforms, lerpTransform, type TransformSnapshot } from '../render/transforms';
import type { FrameState, GameSession } from './GameSession';
import { CorrectionSmoother } from './CorrectionSmoother';
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
/** How long other players' projectiles are remembered after they were last in a snapshot (1 s). */
const PROJECTILE_MEMORY_TICKS = 60;

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
  readonly roomId: string;
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
  /** The last full snapshot (received or rebuilt from deltas); the next delta applies to it. */
  private lastSnapshot: SnapshotMessage | null = null;
  private readonly corrections = new CorrectionSmoother();
  /**
   * Other players' projectiles from recent snapshots. They're drawn slightly in the past like
   * everything else, so one that just hit a wall on the server should still fly for a moment here.
   */
  private readonly recentProjectiles = new Map<number, { projectile: Projectile; lastSeenTick: number }>();
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
    this.roomId = welcome.roomId;
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
      // Remote projectiles that exist at the (delayed) time we're drawing.
      projectiles: new Map([...this.recentProjectiles].filter(([id]) => transforms.has(id)).map(([id, { projectile }]) => [id, projectile])),
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
    this.corrections.apply(transforms, frameDt);
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
    else if (message.type === 'delta') this.onDelta(message);
    else if (message.type === 'pong') this.pingMs = performance.now() - message.time;
  }

  /** Rebuilds the full snapshot from the previous one plus what changed, then handles it as usual. */
  private onDelta(delta: Extract<ServerMessage, { type: 'delta' }>): void {
    const previous = this.lastSnapshot;
    if (!previous) return; // can't happen: the server always sends a full snapshot first
    this.onSnapshot({
      ...previous,
      ...applyDelta(previous, delta),
      type: 'snapshot',
      acks: delta.acks,
      events: delta.events,
      players: delta.players ?? previous.players,
      match: delta.match ?? previous.match,
    });
  }

  private onSnapshot(snapshot: SnapshotMessage): void {
    this.lastSnapshot = snapshot;
    applySnapshot(this.serverWorld, snapshot);
    this.snapshots.push(snapshot.tick, captureTransforms(this.serverWorld), performance.now());
    this.playerList = snapshot.players;
    this.matchState = snapshot.match;
    for (const event of snapshot.events) (event.ownerId === this.myPedId ? this.dueEvents : this.scheduledEvents).push(event);
    for (const projectile of snapshot.projectiles) {
      if (projectile.ownerId !== this.myPedId) this.recentProjectiles.set(projectile.id, { projectile, lastSeenTick: snapshot.tick });
    }
    for (const [id, { lastSeenTick }] of this.recentProjectiles) {
      if (lastSeenTick < snapshot.tick - PROJECTILE_MEMORY_TICKS) this.recentProjectiles.delete(id);
    }

    // Reconcile: restart the prediction from the server's state and replay unacknowledged inputs.
    const before = this.myTransforms();
    const ack = snapshot.acks[this.myPedId] ?? 0;
    this.pending = this.pending.filter((p) => p.seq > ack);
    this.predicted = cloneWorld(this.serverWorld);
    for (const { input } of this.pending) stepWorld(this.predicted, new Map([[this.myPedId, input]]));

    // If that moved us, fade the difference out instead of jumping (see CorrectionSmoother).
    const after = this.myTransforms();
    for (const [id, old] of before) {
      const now = after.get(id);
      if (!now || (old.x === now.x && old.y === now.y && old.heading === now.heading)) continue;
      const previous = this.previousPredicted.get(id);
      if (this.corrections.corrected(id, old, now) && previous) {
        // Move last tick's position by the same amount, so blending between ticks stays smooth too.
        this.previousPredicted.set(id, { x: previous.x - (old.x - now.x), y: previous.y - (old.y - now.y), heading: previous.heading - (old.heading - now.heading) });
      }
    }
  }

  /** Our predicted ped and car (the entities drawn from the prediction), by id. */
  private myTransforms(): TransformSnapshot {
    const result: TransformSnapshot = new Map();
    for (const id of this.predictedIds()) {
      const entity = this.predicted.peds.get(id) ?? this.predicted.cars.get(id);
      if (entity) result.set(id, { x: entity.x, y: entity.y, heading: entity.heading });
    }
    return result;
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
