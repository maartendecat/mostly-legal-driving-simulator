import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEFAULT_MATCH_SETTINGS,
  TICK_DT,
  TICK_RATE,
  parseClientMessage,
  secondsToTicks,
  type MatchSettings,
  type RoomSettings,
  type WorldOptions,
} from '@game/shared';
import { GameRoom, send, type Player } from './GameRoom';
import { staticFileHandler } from './staticFiles';

export interface GameServerOptions {
  port: number;
  /** City seed and match settings for the permanent default room. */
  seed: number;
  match?: Partial<MatchSettings>;
  defaultRoomName?: string;
  /** Rooms players create are closed after being empty this long. */
  emptyRoomTicks?: number;
  maxRooms?: number;
  /** Folder with the built client to serve over HTTP on the same port (production). */
  staticDir?: string;
  /**
   * Who lives in each room's city: traffic, pedestrians, gangs, police, fire brigade (default:
   * nobody). Rooms players create can choose their own police setting.
   */
  city?: WorldOptions;
}

const DEFAULT_EMPTY_ROOM_TICKS = secondsToTicks(60);
const DEFAULT_MAX_ROOMS = 20;
/** How often lobby connections get the room list, if it changed. */
const LOBBY_UPDATE_TICKS = secondsToTicks(1);

/** A connection, and the room it's playing in once it has joined one. */
interface Connection {
  socket: WebSocket;
  room: GameRoom | null;
  player: Player | null;
}

/**
 * The game server: accepts connections, keeps the lobby's room list up to date, creates and closes
 * rooms, and runs every room's simulation at the fixed tick rate.
 */
export class GameServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, GameRoom>();
  private readonly connections = new Set<Connection>();
  private readonly defaultRoom: GameRoom;
  private readonly timer: ReturnType<typeof setInterval>;
  private lastTime = performance.now();
  private accumulator = 0;
  private ticks = 0;
  private lastRoomList = '';

  constructor(private readonly options: GameServerOptions) {
    this.defaultRoom = this.addRoom({
      name: options.defaultRoomName ?? 'Downtown',
      seed: options.seed,
      match: { ...DEFAULT_MATCH_SETTINGS, ...options.match },
      permanent: true,
      city: options.city ?? {},
    });
    // One port for everything: the game page (if built), a health check, and the game connections.
    const serveStatic = options.staticDir ? staticFileHandler(options.staticDir) : null;
    this.http = createServer((request, response) => {
      if (request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: this.rooms.size, players: this.playerCount }));
      } else if (serveStatic) {
        void serveStatic(request, response);
      } else {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Game server: connect with a WebSocket.');
      }
    });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 1024 });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    this.http.listen(options.port);
    this.timer = setInterval(() => this.update(), 1000 / TICK_RATE);
  }

  /** The permanent default room's world. */
  get world() {
    return this.defaultRoom.world;
  }

  /** The permanent default room's match. */
  get match() {
    return this.defaultRoom.match;
  }

  get port(): number {
    const address = this.http.address();
    return address !== null && typeof address === 'object' ? address.port : this.options.port;
  }

  /** Players in all rooms. */
  get playerCount(): number {
    return [...this.rooms.values()].reduce((sum, room) => sum + room.playerCount, 0);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  room(id: string): GameRoom | undefined {
    return this.rooms.get(id);
  }

  /** Resolves once the server is accepting connections. */
  listening(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.http.listening) return resolve();
      this.http.once('listening', resolve);
      this.http.once('error', reject);
    });
  }

  close(): Promise<void> {
    clearInterval(this.timer);
    for (const socket of this.wss.clients) socket.terminate();
    return new Promise((resolve) => this.wss.close(() => this.http.close(() => resolve())));
  }

  private onConnection(socket: WebSocket): void {
    const connection: Connection = { socket, room: null, player: null };
    this.connections.add(connection);
    send(socket, { type: 'rooms', rooms: this.roomList() });

    socket.on('message', (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      if (msg.type === 'ping') {
        send(socket, { type: 'pong', time: msg.time });
      } else if (msg.type === 'input') {
        if (connection.room && connection.player) connection.room.receiveInput(connection.player, msg.seq, msg.input);
      } else if (connection.room) {
        return; // already playing: one room per connection
      } else if (msg.type === 'join') {
        const room = msg.roomId === undefined ? this.defaultRoom : this.rooms.get(msg.roomId);
        if (!room) return send(socket, { type: 'joinFailed', reason: 'That room no longer exists.' });
        if (room.isFull) return send(socket, { type: 'joinFailed', reason: 'That room is full.' });
        this.enter(connection, room, msg.name);
      } else if (msg.type === 'createRoom') {
        if (this.rooms.size >= (this.options.maxRooms ?? DEFAULT_MAX_ROOMS)) {
          return send(socket, { type: 'joinFailed', reason: 'Too many rooms open right now; join one of them instead.' });
        }
        this.enter(connection, this.createRoom(msg.room), msg.name);
      }
    });
    socket.on('close', () => {
      this.connections.delete(connection);
      if (connection.room && connection.player) connection.room.leave(connection.player);
    });
  }

  private enter(connection: Connection, room: GameRoom, name: string): void {
    connection.room = room;
    connection.player = room.join(connection.socket, name);
  }

  private createRoom(settings: RoomSettings): GameRoom {
    const scoreLimits = { ...DEFAULT_MATCH_SETTINGS.scoreLimits };
    if (settings.scoreLimit !== undefined) {
      scoreLimits[settings.mode] = settings.mode === 'tag' ? secondsToTicks(settings.scoreLimit) : settings.scoreLimit;
    }
    const timeLimitTicks =
      settings.timeLimitMinutes !== undefined ? secondsToTicks(settings.timeLimitMinutes * 60) : DEFAULT_MATCH_SETTINGS.timeLimitTicks;
    return this.addRoom({
      name: settings.name || `Room ${this.rooms.size + 1}`,
      seed: randomBytes(4).readUInt32LE(0),
      match: { ...DEFAULT_MATCH_SETTINGS, modes: [settings.mode], scoreLimits, timeLimitTicks },
      permanent: false,
      // (Co-op is against the police: they're always on, army and all.)
      city: { ...this.options.city, ...(settings.mode === 'coop' ? { police: 'on' as const } : settings.police ? { police: settings.police } : {}) },
    });
  }

  private addRoom(options: Omit<ConstructorParameters<typeof GameRoom>[0], 'id'>): GameRoom {
    const room = new GameRoom({ ...options, id: randomBytes(6).toString('base64url') });
    this.rooms.set(room.id, room);
    return room;
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
    this.ticks++;
    const emptyLimit = this.options.emptyRoomTicks ?? DEFAULT_EMPTY_ROOM_TICKS;
    for (const room of this.rooms.values()) {
      room.tick();
      if (!room.options.permanent && room.emptyTicks >= emptyLimit) this.rooms.delete(room.id);
    }
    if (this.ticks % LOBBY_UPDATE_TICKS === 0) this.updateLobby();
  }

  /** Sends the room list to everyone in the lobby, if it changed. */
  private updateLobby(): void {
    const rooms = this.roomList();
    const json = JSON.stringify(rooms);
    if (json === this.lastRoomList) return;
    this.lastRoomList = json;
    for (const connection of this.connections) {
      if (!connection.room) send(connection.socket, { type: 'rooms', rooms });
    }
  }

  private roomList() {
    return [...this.rooms.values()].map((room) => room.info());
  }
}
