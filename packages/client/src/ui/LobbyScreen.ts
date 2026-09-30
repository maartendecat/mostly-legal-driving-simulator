import { MAX_NAME_LENGTH, MAX_ROOM_NAME_LENGTH, type MatchMode, type RoomInfo } from '@game/shared';
import type { GameSession } from '../session/GameSession';
import { Lobby } from '../session/Lobby';

const NAME_STORAGE_KEY = 'playerName';

const MODE_NAMES: Record<MatchMode, string> = { frag: 'Frag', points: 'Points', tag: 'Tag' };

export interface LobbyScreenOptions {
  serverUrl: string;
  lagMs: number;
  playOffline: () => GameSession;
}

/**
 * The first screen: pick a name, then join a room from the live list or create one. Resolves with
 * a session once the player is in a game (online or offline).
 */
export function showLobbyScreen({ serverUrl, lagMs, playOffline }: LobbyScreenOptions): Promise<GameSession> {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const screen = $('lobby');
  const nameInput = $<HTMLInputElement>('lobby-name');
  const roomList = $('lobby-rooms');
  const status = $('lobby-status');
  const retryButton = $<HTMLButtonElement>('lobby-retry');
  const createForm = $<HTMLFormElement>('lobby-create');
  const roomNameInput = $<HTMLInputElement>('lobby-room-name');
  const modeSelect = $<HTMLSelectElement>('lobby-mode');
  const timeSelect = $<HTMLSelectElement>('lobby-time');
  const createButton = $<HTMLButtonElement>('lobby-create-button');
  const offlineButton = $<HTMLButtonElement>('lobby-offline');
  const error = $('lobby-error');

  nameInput.maxLength = MAX_NAME_LENGTH;
  roomNameInput.maxLength = MAX_ROOM_NAME_LENGTH;
  nameInput.value = loadName();
  screen.hidden = false;
  nameInput.focus();
  nameInput.select();

  return new Promise((resolve) => {
    let lobby: Lobby | null = null;
    let joining = false;

    const finish = (session: GameSession) => {
      screen.hidden = true;
      resolve(session);
    };
    const setBusy = (busy: boolean) => {
      joining = busy;
      createButton.disabled = busy || !lobby;
      roomList.querySelectorAll('button').forEach((b) => (b.disabled = busy));
    };
    const playerName = () => {
      const name = nameInput.value.trim();
      saveName(name);
      return name;
    };

    /** Joins or creates a room; on failure shows why and stays in the lobby. */
    const enter = async (attempt: (lobby: Lobby) => Promise<GameSession>) => {
      if (!lobby || joining) return;
      setBusy(true);
      error.textContent = '';
      try {
        finish(await attempt(lobby));
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        setBusy(false);
      }
    };

    const renderRooms = (rooms: RoomInfo[]) => {
      roomList.replaceChildren(
        ...rooms.map((room) => {
          const row = document.createElement('li');
          const name = document.createElement('span');
          name.className = 'room-name';
          name.textContent = room.name; // typed by players: only ever as text
          const details = document.createElement('span');
          details.className = 'room-details';
          details.textContent = `${MODE_NAMES[room.mode]} · ${room.players}/${room.maxPlayers}${room.phase === 'intermission' ? ' · between matches' : ''}`;
          const join = document.createElement('button');
          join.type = 'button';
          join.textContent = room.players >= room.maxPlayers ? 'Full' : 'Join';
          join.disabled = joining || room.players >= room.maxPlayers;
          join.addEventListener('click', () => enter((l) => l.join(playerName(), room.id)));
          row.append(name, details, join);
          return row;
        }),
      );
      status.textContent = rooms.length === 0 ? 'No rooms yet: create one below.' : '';
    };

    const connect = async () => {
      retryButton.hidden = true;
      status.textContent = `Connecting to ${serverUrl}...`;
      createButton.disabled = true;
      try {
        lobby = await Lobby.open(serverUrl, { lagMs });
        lobby.onRooms = renderRooms;
        renderRooms(lobby.rooms);
        createButton.disabled = false;
        // Opened through an invite link (…#room=abc): go straight into that room.
        const invited = new URLSearchParams(location.hash.slice(1)).get('room');
        if (invited) {
          if (lobby.rooms.some((r) => r.id === invited)) enter((l) => l.join(playerName(), invited));
          else error.textContent = 'The room from your invite link is gone; pick another one.';
        }
      } catch (e) {
        console.warn(e);
        status.textContent = `Can't reach the game server at ${serverUrl}. Is it running? (npm run server)`;
        retryButton.hidden = false;
      }
    };

    // Enter in the name field joins the first room with space.
    nameInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const room = lobby?.rooms.find((r) => r.players < r.maxPlayers);
      if (room) enter((l) => l.join(playerName(), room.id));
    });
    createForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const mode = modeSelect.value as MatchMode;
      const minutes = Number(timeSelect.value);
      enter((l) => l.create(playerName(), { name: roomNameInput.value.trim(), mode, timeLimitMinutes: minutes }));
    });
    retryButton.addEventListener('click', connect);
    offlineButton.addEventListener('click', () => {
      lobby?.close();
      finish(playOffline());
    });
    void connect();
  });
}

// Remembering the name is a convenience; storage can be unavailable (private mode, blocked).
function loadName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // ignore
  }
}
