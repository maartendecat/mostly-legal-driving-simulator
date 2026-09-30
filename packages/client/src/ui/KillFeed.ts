import type { GameSession } from '../session/GameSession';
import { causeName, playerName, type DeathEvent } from './deathText';

const MAX_ENTRIES = 5;
const ENTRY_LIFETIME_MS = 6000;

/** "Bob ▸ Alice  pistol" lines in the corner, newest at the bottom. */
export class KillFeed {
  constructor(private readonly container: HTMLElement) {}

  add(session: GameSession, death: DeathEvent): void {
    const entry = document.createElement('div');
    entry.className = 'kill';
    const me = session.myPedId;
    if (death.killerId === me || death.pedId === me) entry.classList.add('mine');

    // Names are typed by other players, so they only ever go in as text.
    const name = (pedId: number) => {
      const span = document.createElement('span');
      span.className = pedId === me ? 'name me' : 'name';
      span.textContent = playerName(session, pedId);
      return span;
    };
    if (death.killerId === null) {
      entry.append('☠ ', name(death.pedId), ' ');
    } else if (death.killerId === death.pedId) {
      entry.append(name(death.pedId), ' ☠ own ');
    } else {
      entry.append(name(death.killerId), ' ▸ ', name(death.pedId), ' ');
    }
    const cause = document.createElement('span');
    cause.className = 'cause';
    cause.textContent = causeName(death.cause);
    entry.append(cause);

    this.container.append(entry);
    while (this.container.children.length > MAX_ENTRIES) this.container.firstElementChild!.remove();
    setTimeout(() => entry.remove(), ENTRY_LIFETIME_MS);
  }
}
