import type { ClientMessage, RoomInfo, RoomSettings, ServerMessage } from '@game/shared';
import { NetworkSession } from './NetworkSession';

export interface LobbyOptions {
  timeoutMs?: number;
  /** Artificial round-trip delay for the game session, to test how it feels on a slow connection. */
  lagMs?: number;
}

/**
 * A connection to the server before joining a room: receives the room list as it changes, and
 * joins or creates a room, which hands the connection over to a NetworkSession.
 */
export class Lobby {
  rooms: RoomInfo[] = [];
  /** Called whenever the room list changes. */
  onRooms: (rooms: RoomInfo[]) => void = () => {};
  private busy = false;

  /** Connects and resolves once the server has sent the first room list. */
  static open(url: string, { timeoutMs = 3000, lagMs = 0 }: LobbyOptions = {}): Promise<Lobby> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const fail = (reason: string) => {
        clearTimeout(timer);
        socket.close();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail(`Timed out connecting to ${url}`), timeoutMs);
      socket.addEventListener('error', () => fail(`Could not connect to ${url}`));
      const lobby = new Lobby(socket, lagMs);
      const onFirstRooms = (event: MessageEvent) => {
        if ((JSON.parse(event.data as string) as ServerMessage).type !== 'rooms') return;
        clearTimeout(timer);
        socket.removeEventListener('message', onFirstRooms);
        resolve(lobby);
      };
      socket.addEventListener('message', onFirstRooms);
    });
  }

  private constructor(
    private readonly socket: WebSocket,
    private readonly lagMs: number,
  ) {
    socket.addEventListener('message', this.onMessage);
  }

  /** Joins a room (the server's default room without `roomId`). */
  join(name: string, roomId?: string): Promise<NetworkSession> {
    return this.enter({ type: 'join', name, ...(roomId !== undefined ? { roomId } : {}) });
  }

  /** Creates a room and joins it. */
  create(name: string, room: RoomSettings): Promise<NetworkSession> {
    return this.enter({ type: 'createRoom', name, room });
  }

  close(): void {
    this.socket.close();
  }

  private readonly onMessage = (event: MessageEvent) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    if (message.type !== 'rooms') return;
    this.rooms = message.rooms;
    this.onRooms(message.rooms);
  };

  /** Sends a join/create request; resolves with the game session, or rejects with the server's reason. */
  private enter(request: ClientMessage): Promise<NetworkSession> {
    if (this.busy) return Promise.reject(new Error('Already joining a room.'));
    this.busy = true;
    return new Promise((resolve, reject) => {
      const onReply = (event: MessageEvent) => {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === 'joinFailed') {
          this.socket.removeEventListener('message', onReply);
          this.busy = false;
          reject(new Error(message.reason));
        } else if (message.type === 'welcome') {
          this.socket.removeEventListener('message', onReply);
          this.socket.removeEventListener('message', this.onMessage);
          // Created synchronously, so no snapshot can slip past between welcome and the session's listener.
          resolve(NetworkSession.fromWelcome(this.socket, message, this.lagMs));
        }
      };
      this.socket.addEventListener('message', onReply);
      this.socket.send(JSON.stringify(request));
    });
  }
}
