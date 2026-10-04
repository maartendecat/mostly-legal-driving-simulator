import { TICK_RATE, scoreFor, type MatchMode, type PlayerInfo } from '@game/shared';
import type { GameSession } from '../session/GameSession';

/** Best first: highest score for the mode, then fewest deaths, then by name so the order is stable. */
export function rankPlayers(players: readonly PlayerInfo[], mode: MatchMode): PlayerInfo[] {
  return [...players].sort((a, b) => scoreFor(mode, b) - scoreFor(mode, a) || a.deaths - b.deaths || a.name.localeCompare(b.name));
}

/** How each mode names and shows its score, and which second column the scoreboard shows. */
const MODES: Record<MatchMode, { title: string; score: string; format: (value: number) => string; limit: (limit: number) => string; extra: [string, (p: PlayerInfo) => number] }> = {
  frag: { title: 'FRAG', score: 'Frags', format: String, limit: (l) => `first to ${l}`, extra: ['Deaths', (p) => p.deaths] },
  points: { title: 'POINTS', score: 'Points', format: (v) => v.toLocaleString('en-US'), limit: (l) => `first to ${l.toLocaleString('en-US')}`, extra: ['Frags', (p) => p.frags] },
  tag: { title: 'TAG', score: 'Time as it', format: formatTime, limit: (l) => `first to ${formatTime(l)} as it`, extra: ['Deaths', (p) => p.deaths] },
  coop: { title: 'AGAINST THE POLICE', score: 'Points', format: (v) => v.toLocaleString('en-US'), limit: () => '', extra: ['Lives', (p) => p.lives] },
};

const hearts = (lives: number) => (lives > 0 ? '♥'.repeat(lives) : 'out');

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
    const mode = MODES[match.mode];
    const score = (p: PlayerInfo) => mode.format(scoreFor(match.mode, p));
    const ranked = rankPlayers(session.players, match.mode);
    const tick = session.world.tick;
    const myRank = ranked.findIndex((p) => p.pedId === session.myPedId) + 1;
    const me = ranked[myRank - 1];
    const leader = ranked[0];
    const itId = session.world.itPedId;

    const lines = [`${mode.title}${match.scoreLimit > 0 ? ` · ${mode.limit(match.scoreLimit)}` : ''}`];
    if (match.phase === 'intermission') lines.push('Match over');
    else if (match.endsAt !== null) lines.push(`${formatTime(match.endsAt - tick)} left`);
    if (match.mode === 'tag' && itId !== null && match.phase === 'playing') {
      lines.push(itId === session.myPedId ? "You're IT! Stay alive" : `IT: ${ranked.find((p) => p.pedId === itId)?.name ?? '?'}`);
    }
    if (match.mode === 'coop') {
      // Together: how long the team has held out, the room's best, and lives left.
      const time = match.heldOut ?? tick - match.startedAt;
      lines.push(`Held out ${formatTime(time)}${match.bestHeldOut !== null ? ` · best ${formatTime(match.bestHeldOut)}` : ''}`);
      if (me) lines.push(`Your lives: ${hearts(me.lives)}`);
      const left = ranked.filter((p) => p.lives > 0).length;
      if (ranked.length > 1) lines.push(`${left} of ${ranked.length} still in`);
    } else {
      if (me) lines.push(`You: ${score(me)} · ${ordinal(myRank)} of ${ranked.length}`);
      if (leader && leader !== me) lines.push(`Leader: ${leader.name} ${score(leader)}`);
    }
    this.status.textContent = lines.join('\n');

    const intermission = match.phase === 'intermission';
    this.board.hidden = !this.held && !intermission;
    if (this.board.hidden) return;

    const winners = ranked.filter((p) => match.winnerIds.includes(p.pedId)).map((p) => p.name);
    const title = !intermission
      ? 'Scores'
      : match.mode === 'coop'
        ? `Held out ${formatTime(match.heldOut ?? 0)}${match.heldOut !== null && match.heldOut >= (match.bestHeldOut ?? 0) ? ': a new best!' : ''}`
        : winners.length === 1
        ? `${winners[0]} wins!`
        : winners.length > 1
          ? `Draw: ${winners.join(', ')}`
          : 'Match over';
    const footer = intermission && match.restartAt !== null ? `Next match in ${formatTime(match.restartAt - tick)}` : '';
    const columns: [string, (p: PlayerInfo) => string][] = [
      [mode.score, score],
      [mode.extra[0], (p) => String(mode.extra[1](p))],
    ];
    const key = JSON.stringify([title, footer, ranked, session.myPedId, match.mode]);
    if (key !== this.lastRendered) {
      this.lastRendered = key;
      this.render(title, footer, ranked, session.myPedId, columns);
    }
  }

  private render(title: string, footer: string, ranked: PlayerInfo[], myPedId: number | null, columns: [string, (p: PlayerInfo) => string][]): void {
    const heading = document.createElement('h2');
    heading.textContent = title;
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const label of ['#', 'Player', ...columns.map(([name]) => name)]) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    const body = table.createTBody();
    ranked.forEach((player, i) => {
      const row = body.insertRow();
      if (player.pedId === myPedId) row.className = 'me';
      // Names are typed by other players, so they only ever go in as text.
      for (const value of [String(i + 1), player.name, ...columns.map(([, cell]) => cell(player))]) row.insertCell().textContent = value;
    });
    const foot = document.createElement('p');
    foot.textContent = footer;
    this.board.replaceChildren(heading, table, foot);
  }
}
