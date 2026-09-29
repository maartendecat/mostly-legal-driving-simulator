import { MAX_NAME_LENGTH } from '@game/shared';
import type { GameSession } from '../session/GameSession';

const NAME_STORAGE_KEY = 'playerName';

export interface JoinScreenOptions {
  serverUrl: string;
  connect: (name: string) => Promise<GameSession>;
  playOffline: () => GameSession;
}

/** Shows the join form and resolves with a session once the player is in a game. */
export function showJoinScreen({ serverUrl, connect, playOffline }: JoinScreenOptions): Promise<GameSession> {
  const screen = document.getElementById('join')!;
  const form = document.getElementById('join-form') as HTMLFormElement;
  const nameInput = document.getElementById('join-name') as HTMLInputElement;
  const playButton = document.getElementById('join-play') as HTMLButtonElement;
  const offlineButton = document.getElementById('join-offline') as HTMLButtonElement;
  const error = document.getElementById('join-error')!;

  nameInput.maxLength = MAX_NAME_LENGTH;
  nameInput.value = loadName();
  screen.hidden = false;
  nameInput.focus();
  nameInput.select();

  return new Promise((resolve) => {
    const finish = (session: GameSession) => {
      screen.hidden = true;
      resolve(session);
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      saveName(name);
      playButton.disabled = true;
      playButton.textContent = 'Connecting...';
      error.textContent = '';
      try {
        finish(await connect(name));
      } catch (e) {
        console.warn(e);
        error.textContent = `Can't reach the game server at ${serverUrl}. Is it running? (npm run server)`;
        playButton.disabled = false;
        playButton.textContent = 'Play online';
      }
    });
    offlineButton.addEventListener('click', () => finish(playOffline()));
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
