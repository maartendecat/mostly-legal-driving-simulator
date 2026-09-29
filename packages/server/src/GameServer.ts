import { WebSocket, WebSocketServer } from 'ws';
import {
  NO_INPUT,
  SNAPSHOT_EVERY_TICKS,
  TICK_DT,
  TICK_RATE,
  captureSnapshot,
  createWorld,
  generateCity,
  parseClientMessage,
  removePed,
  spawnPed,
  stepWorld,
  type PlayerInput,
  type ServerMessage,
  type World,
} from '@game/shared';

export interface GameServerOptions {
  port: number;
  seed: number;
}

interface Player {
  socket: WebSocket;
  pedId: number;
  /** The most recent input the client sent; it stays in effect until the next one arrives. */
  input: PlayerInput;
  /** Set when an `enter` press arrives, so a quick tap between two ticks isn't lost. */
  enterLatched: boolean;
}

/**
 * Authoritative game server: owns the only real copy of the world, applies player inputs and
 * broadcasts snapshots. Clients never tell the server where they are, only which keys are down.
 */
export class GameServer {
  readonly world: World;
  private readonly wss: WebSocketServer;
  private readonly players = new Set<Player>();
  private readonly timer: ReturnType<typeof setInterval>;
  private lastTime = performance.now();
  private accumulator = 0;

  constructor(private readonly options: GameServerOptions) {
    this.world = createWorld(generateCity(options.seed), options.seed);
    this.wss = new WebSocketServer({ port: options.port, maxPayload: 1024 });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    this.timer = setInterval(() => this.update(), 1000 / TICK_RATE);
  }

  get port(): number {
    const address = this.wss.address();
    return address !== null && typeof address === 'object' ? address.port : this.options.port;
  }

  get playerCount(): number {
    return this.players.size;
  }

  /** Resolves once the server is accepting connections. */
  listening(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.wss.address()) return resolve();
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });
  }

  close(): Promise<void> {
    clearInterval(this.timer);
    for (const player of this.players) player.socket.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(socket: WebSocket): void {
    const ped = spawnPed(this.world);
    const player: Player = { socket, pedId: ped.id, input: { ...NO_INPUT }, enterLatched: false };
    this.players.add(player);
    send(socket, {
      type: 'welcome',
      pedId: ped.id,
      seed: this.options.seed,
      tickRate: TICK_RATE,
      snapshotEveryTicks: SNAPSHOT_EVERY_TICKS,
    });
    send(socket, { type: 'snapshot', ...captureSnapshot(this.world) });

    socket.on('message', (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      if (msg.type === 'input') {
        player.input = msg.input;
        if (msg.input.enter) player.enterLatched = true;
      } else {
        send(socket, { type: 'pong', time: msg.time });
      }
    });
    socket.on('close', () => {
      this.players.delete(player);
      removePed(this.world, player.pedId);
    });
  }

  private update(): void {
    const now = performance.now();
    this.accumulator += Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;
    while (this.accumulator >= TICK_DT) {
      this.tick();
      this.accumulator -= TICK_DT;
    }
  }

  private tick(): void {
    const inputs = new Map<number, PlayerInput>();
    for (const player of this.players) {
      inputs.set(player.pedId, { ...player.input, enter: player.input.enter || player.enterLatched });
      player.enterLatched = false;
    }
    stepWorld(this.world, inputs);

    if (this.world.tick % SNAPSHOT_EVERY_TICKS === 0 && this.players.size > 0) {
      const message = JSON.stringify({ type: 'snapshot', ...captureSnapshot(this.world) } satisfies ServerMessage);
      for (const player of this.players) {
        if (player.socket.readyState === WebSocket.OPEN) player.socket.send(message);
      }
    }
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}
