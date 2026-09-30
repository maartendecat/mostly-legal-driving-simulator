import { TICK_RATE, type PlayerInfo } from '@game/shared';
import type { GameSession } from '../session/GameSession';

/** Best first: most frags, then fewest deaths, then by name so the order is stable. */
export function rankPlayers(players: readonly PlayerInfo[]): PlayerInfo[] {
  return [...players].sort((a, b) => b.frags - a.frags || a.deaths - b.deaths || a.name.localeCompare(b.name));
}

function formatTime(ticks: number): string {
  const seconds = Math.max(0, Math.ceil(ticks / TICK_RATE));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * The match status in the corner, and the full scoreboard: shown while Tab is held, and
 * automatically between matches with the winner.
 */
export class Scoreboard {
  /** Set while the player holds Tab. */
  held = false;
  private lastRendered = '';

  constructor(
    private readonly status: HTMLElement,
    private readonly board: HTMLElement,
  ) {}

  update(session: GameSession): void {
    const { match } = session;
    this.status.hidden = match === null;
    if (!match) {
      this.board.hidden = true;
      return;
    }
    const ranked = rankPlayers(session.players);
    const tick = session.world.tick;
    const myRank = ranked.findIndex((p) => p.pedId === session.myPedId) + 1;
    const me = ranked[myRank - 1];
    const leader = ranked[0];

    const lines = [`FRAG${match.fragLimit > 0 ? ` · first to ${match.fragLimit}` : ''}`];
    if (match.phase === 'intermission') lines.push('Match over');
    else if (match.endsAt !== null) lines.push(`${formatTime(match.endsAt - tick)} left`);
    if (me) lines.push(`You: ${me.frags} · ${ordinal(myRank)} of ${ranked.length}`);
    if (leader && leader !== me) lines.push(`Leader: ${leader.name} ${leader.frags}`);
    this.status.textContent = lines.join('\n');

    const intermission = match.phase === 'intermission';
    this.board.hidden = !this.held && !intermission;
    if (this.board.hidden) return;

    const winners = ranked.filter((p) => match.winnerIds.includes(p.pedId)).map((p) => p.name);
    const title = !intermission
      ? 'Scores'
      : winners.length === 1
        ? `${winners[0]} wins!`
        : winners.length > 1
          ? `Draw: ${winners.join(', ')}`
          : 'Match over';
    const footer = intermission && match.restartAt !== null ? `Next match in ${formatTime(match.restartAt - tick)}` : '';
    const key = JSON.stringify([title, footer, ranked, session.myPedId]);
    if (key !== this.lastRendered) {
      this.lastRendered = key;
      this.render(title, footer, ranked, session.myPedId);
    }
  }

  private render(title: string, footer: string, ranked: PlayerInfo[], myPedId: number | null): void {
    const heading = document.createElement('h2');
    heading.textContent = title;
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const label of ['#', 'Player', 'Frags', 'Deaths']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    const body = table.createTBody();
    ranked.forEach((player, i) => {
      const row = body.insertRow();
      if (player.pedId === myPedId) row.className = 'me';
      // Names are typed by other players, so they only ever go in as text.
      for (const value of [String(i + 1), player.name, String(player.frags), String(player.deaths)]) row.insertCell().textContent = value;
    });
    const foot = document.createElement('p');
    foot.textContent = footer;
    this.board.replaceChildren(heading, table, foot);
  }
}
