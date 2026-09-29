import { WebSocket, WebSocketServer } from 'ws';
import {
  MAX_QUEUED_INPUTS,
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
  /** Inputs received but not yet applied, oldest first. */
  queue: { seq: number; input: PlayerInput }[];
  /** The input applied last tick; repeated if the queue runs dry (late or lost packets). */
  input: PlayerInput;
  /** `seq` of the last input applied, reported back to the client for reconciliation. */
  ack: number;
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
    const player: Player = { socket, pedId: ped.id, queue: [], input: { ...NO_INPUT }, ack: 0 };
    this.players.add(player);
    send(socket, {
      type: 'welcome',
      pedId: ped.id,
      seed: this.options.seed,
      tickRate: TICK_RATE,
      snapshotEveryTicks: SNAPSHOT_EVERY_TICKS,
    });
    send(socket, { type: 'snapshot', ...captureSnapshot(this.world), acks: this.acks() });

    socket.on('message', (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      if (msg.type === 'input') {
        const newest = player.queue.at(-1)?.seq ?? player.ack;
        if (msg.seq <= newest) return; // duplicate or out of order
        player.queue.push({ seq: msg.seq, input: msg.input });
        if (player.queue.length > MAX_QUEUED_INPUTS) player.queue.shift();
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
      const next = player.queue.shift();
      if (next) {
        player.input = next.input;
        player.ack = next.seq;
      }
      inputs.set(player.pedId, player.input);
    }
    stepWorld(this.world, inputs);

    if (this.world.tick % SNAPSHOT_EVERY_TICKS === 0 && this.players.size > 0) {
      const message = JSON.stringify({ type: 'snapshot', ...captureSnapshot(this.world), acks: this.acks() } satisfies ServerMessage);
      for (const player of this.players) {
        if (player.socket.readyState === WebSocket.OPEN) player.socket.send(message);
      }
    }
  }

  private acks(): Record<number, number> {
    const acks: Record<number, number> = {};
    for (const player of this.players) acks[player.pedId] = player.ack;
    return acks;
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}
