import {
  TICK_DT,
  applySnapshot,
  createWorld,
  generateCity,
  type ClientMessage,
  type PlayerInput,
  type ServerMessage,
  type World,
} from '@game/shared';
import { captureTransforms, type TransformSnapshot } from '../render/GameRenderer';
import type { FrameState, GameSession } from './GameSession';

type Welcome = Extract<ServerMessage, { type: 'welcome' }>;

const PING_INTERVAL_MS = 2000;

/**
 * Multiplayer: the server owns the world. This client only sends its input and draws the
 * snapshots it receives, blending from the previous snapshot to the latest one.
 *
 * Your own movement lags by the round-trip time for now; client-side prediction fixes that next.
 */
export class NetworkSession implements GameSession {
  readonly world: World;
  readonly myPedId: number;
  private previous: TransformSnapshot;
  private readonly snapshotInterval: number;
  private sinceSnapshot = 0;
  private inputAccumulator = 0;
  private lastSentInput = '';
  private pingMs: number | null = null;
  private connected = true;

  /** Connects to a game server and resolves once the server has welcomed us. */
  static connect(url: string, timeoutMs = 3000): Promise<NetworkSession> {
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
        resolve(new NetworkSession(socket, message));
      };
      socket.addEventListener('message', onWelcome);
    });
  }

  private constructor(
    private readonly socket: WebSocket,
    welcome: Welcome,
  ) {
    this.myPedId = welcome.pedId;
    this.snapshotInterval = welcome.snapshotEveryTicks / welcome.tickRate;
    // The map is generated from the seed; entities come from snapshots.
    this.world = createWorld(generateCity(welcome.seed), welcome.seed);
    this.world.cars.clear();
    this.previous = captureTransforms(this.world);

    socket.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data as string) as ServerMessage));
    socket.addEventListener('close', () => (this.connected = false));
    const pinger = setInterval(() => {
      if (!this.connected) return clearInterval(pinger);
      this.send({ type: 'ping', time: performance.now() });
    }, PING_INTERVAL_MS);
    this.send({ type: 'ping', time: performance.now() });
  }

  get status(): string {
    if (!this.connected) return 'Disconnected from server';
    const ping = this.pingMs === null ? '' : ` · ${Math.round(this.pingMs)} ms`;
    return `Online · ${this.world.peds.size} player${this.world.peds.size === 1 ? '' : 's'}${ping}`;
  }

  update(frameDt: number, sampleInput: () => PlayerInput): FrameState {
    // Sample input at the tick rate (so short taps are seen) but only send it when it changes.
    this.inputAccumulator += frameDt;
    while (this.inputAccumulator >= TICK_DT) {
      const input = sampleInput();
      const key = JSON.stringify(input);
      if (key !== this.lastSentInput) {
        this.lastSentInput = key;
        this.send({ type: 'input', input });
      }
      this.inputAccumulator -= TICK_DT;
    }
    this.sinceSnapshot += frameDt;
    return { previous: this.previous, alpha: Math.min(this.sinceSnapshot / this.snapshotInterval, 1) };
  }

  private onMessage(message: ServerMessage): void {
    if (message.type === 'snapshot') {
      this.previous = captureTransforms(this.world);
      applySnapshot(this.world, message);
      this.sinceSnapshot = 0;
    } else if (message.type === 'pong') {
      this.pingMs = performance.now() - message.time;
    }
  }

  private send(message: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
