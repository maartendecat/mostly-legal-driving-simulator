import {
  TICK_DT,
  applySnapshot,
  cloneWorld,
  createWorld,
  generateCity,
  stepWorld,
  type ClientMessage,
  type PlayerInput,
  type ServerMessage,
  type World,
} from '@game/shared';
import { captureTransforms, interpolateTransforms, lerpTransform, type TransformSnapshot } from '../render/GameRenderer';
import type { FrameState, GameSession } from './GameSession';

type Welcome = Extract<ServerMessage, { type: 'welcome' }>;
type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;

export interface ConnectOptions {
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
 * Our own ped and car are drawn from the prediction; everything else from the server snapshots.
 */
export class NetworkSession implements GameSession {
  readonly myPedId: number;
  private readonly serverWorld: World;
  private predicted: World;
  private displayWorld: World;
  private pending: { seq: number; input: PlayerInput }[] = [];
  private nextSeq = 1;
  private previousServer: TransformSnapshot;
  private previousPredicted: TransformSnapshot;
  private sinceSnapshot = 0;
  private accumulator = 0;
  private readonly snapshotInterval: number;
  private pingMs: number | null = null;
  private connected = true;

  /** Connects to a game server and resolves once the server has welcomed us. */
  static connect(url: string, { timeoutMs = 3000, lagMs = 0 }: ConnectOptions = {}): Promise<NetworkSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const fail = (reason: string) => {
        clearTimeout(timer);
        socket.close();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail(`Timed out connecting to ${url}`), timeoutMs);
      socket.addEventListener('error', () => fail(`Could not connect to ${url}`));
      const onWelcome = (event: MessageEvent) => {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type !== 'welcome') return;
        clearTimeout(timer);
        socket.removeEventListener('message', onWelcome);
        // Constructed synchronously, so no message can slip past between welcome and the session's listener.
        resolve(new NetworkSession(socket, message, lagMs));
      };
      socket.addEventListener('message', onWelcome);
    });
  }

  private constructor(
    private readonly socket: WebSocket,
    welcome: Welcome,
    private readonly lagMs: number,
  ) {
    this.myPedId = welcome.pedId;
    this.snapshotInterval = welcome.snapshotEveryTicks / welcome.tickRate;
    // The map is generated from the seed; entities come from snapshots.
    this.serverWorld = createWorld(generateCity(welcome.seed), welcome.seed);
    this.serverWorld.cars.clear();
    this.predicted = cloneWorld(this.serverWorld);
    this.displayWorld = this.serverWorld;
    this.previousServer = new Map();
    this.previousPredicted = new Map();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      this.delayed(() => this.onMessage(message));
    });
    socket.addEventListener('close', () => (this.connected = false));
    const pinger = setInterval(() => {
      if (!this.connected) return clearInterval(pinger);
      this.send({ type: 'ping', time: performance.now() });
    }, PING_INTERVAL_MS);
    this.send({ type: 'ping', time: performance.now() });
  }

  get world(): World {
    return this.displayWorld;
  }

  get status(): string {
    if (!this.connected) return 'Disconnected from server';
    const players = this.serverWorld.peds.size;
    const ping = this.pingMs === null ? '' : ` · ${Math.round(this.pingMs)} ms`;
    const lag = this.lagMs > 0 ? ` (incl. ${this.lagMs} ms simulated lag)` : '';
    return `Online · ${players} player${players === 1 ? '' : 's'}${ping}${lag}`;
  }

  update(frameDt: number, sampleInput: () => PlayerInput): FrameState {
    this.accumulator += frameDt;
    while (this.accumulator >= TICK_DT) {
      const input = sampleInput();
      const seq = this.nextSeq++;
      this.pending.push({ seq, input });
      this.send({ type: 'input', seq, input });
      this.previousPredicted = captureTransforms(this.predicted);
      stepWorld(this.predicted, new Map([[this.myPedId, input]]));
      this.accumulator -= TICK_DT;
    }
    this.sinceSnapshot += frameDt;

    // Everyone else: blend between the last two server snapshots.
    const transforms = interpolateTransforms(this.previousServer, this.serverWorld, Math.min(this.sinceSnapshot / this.snapshotInterval, 1));
    // Ourselves: blend between the last two predicted ticks.
    const display: World = { ...this.serverWorld, peds: new Map(this.serverWorld.peds), cars: new Map(this.serverWorld.cars) };
    const alpha = this.accumulator / TICK_DT;
    for (const id of this.predictedIds()) {
      const ped = this.predicted.peds.get(id);
      const car = this.predicted.cars.get(id);
      const entity = ped ?? car;
      if (!entity) continue;
      if (ped) display.peds.set(id, ped);
      if (car) display.cars.set(id, car);
      transforms.set(id, lerpTransform(this.previousPredicted.get(id) ?? entity, entity, alpha));
    }
    this.displayWorld = display;
    return { transforms };
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
    this.previousServer = captureTransforms(this.serverWorld);
    applySnapshot(this.serverWorld, snapshot);
    this.sinceSnapshot = 0;

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
