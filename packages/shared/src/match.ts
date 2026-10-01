import { isDead, respawnPed } from './damage';
import { randomPick } from './math';
import { secondsToTicks } from './time';
import type { World } from './world';

/**
 * The multiplayer game modes, as in GTA2:
 *  - frag:   +1 per kill, −1 for killing yourself. Most frags wins.
 *  - points: kills are worth a big bonus, wrecking cars earns a little. Most points wins.
 *  - tag:    one player is "it". Whoever kills "it" becomes "it". Longest time as "it" wins.
 *
 * A match ends when someone reaches the score limit or time runs out. Then there's a short
 * intermission showing the scores, everyone respawns, and the next match starts.
 */

export type MatchMode = 'frag' | 'points' | 'tag';
export const MATCH_MODES: readonly MatchMode[] = ['frag', 'points', 'tag'];

export type MatchPhase = 'playing' | 'intermission';

export interface MatchSettings {
  /** Modes to play in turn; a single entry always plays the same mode. */
  modes: MatchMode[];
  /** Score needed to win, per mode: frags, points, or ticks spent as "it". 0 for no limit. */
  scoreLimits: Record<MatchMode, number>;
  /** Match length in ticks; 0 for no limit. */
  timeLimitTicks: number;
  /** Pause between matches, showing the final scores. */
  intermissionTicks: number;
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  modes: ['frag'],
  scoreLimits: { frag: 10, points: 10_000, tag: secondsToTicks(120) },
  timeLimitTicks: secondsToTicks(10 * 60),
  intermissionTicks: secondsToTicks(10),
};

/** Points mode scoring. */
export const POINTS = {
  kill: 1000,
  suicide: -500,
  carDestroyed: 100,
  /** Killing one of the city's people: a little, as in GTA2; more for gang members and cops. */
  pedestrian: 10,
  gangster: 20,
  cop: 50,
} as const;

/** What clients need to know about the match; sent in every snapshot. */
export interface MatchState {
  mode: MatchMode;
  phase: MatchPhase;
  /** Score needed to win, in the mode's units (see MatchSettings.scoreLimits); 0 for none. */
  scoreLimit: number;
  /** Tick at which the match ends on time, or null without a time limit. */
  endsAt: number | null;
  /** During intermission: the tick at which the next match starts. */
  restartAt: number | null;
  /** The players with the best score when the match ended (more than one on a tie). */
  winnerIds: number[];
}

export interface PlayerScore {
  frags: number;
  deaths: number;
  points: number;
  /** Ticks spent alive as "it" (tag). */
  itTicks: number;
}

/** The number that decides who wins in `mode`. */
export function scoreFor(mode: MatchMode, score: PlayerScore): number {
  return mode === 'frag' ? score.frags : mode === 'points' ? score.points : score.itTicks;
}

function emptyScore(): PlayerScore {
  return { frags: 0, deaths: 0, points: 0, itTicks: 0 };
}

export class Match {
  state: MatchState;
  /** Scores by ped id, for every player in the game. */
  readonly scores = new Map<number, PlayerScore>();
  private modeIndex = 0;

  constructor(
    private readonly settings: MatchSettings,
    world: World,
  ) {
    this.state = this.newMatchState(world);
  }

  addPlayer(world: World, pedId: number): void {
    if (!this.scores.has(pedId)) this.scores.set(pedId, emptyScore());
    if (this.state.mode === 'tag' && world.itPedId === null) world.itPedId = pedId;
  }

  removePlayer(world: World, pedId: number): void {
    this.scores.delete(pedId);
    if (world.itPedId === pedId) world.itPedId = this.randomPlayer(world);
  }

  /** Scores this tick's events and moves the match along. Call after every world step. */
  update(world: World): void {
    if (this.state.phase === 'intermission') {
      if (world.tick >= this.state.restartAt!) this.startNewMatch(world);
      return;
    }
    for (const event of world.events) {
      if (event.type === 'death') this.scoreDeath(world, event.pedId, event.killerId);
      else if (event.type === 'carDestroyed' && event.attackerId !== null) this.addPoints(event.attackerId, POINTS.carDestroyed);
    }
    if (this.state.mode === 'tag' && world.itPedId !== null) {
      const it = world.peds.get(world.itPedId);
      const score = this.scores.get(world.itPedId);
      if (it && score && !isDead(it)) score.itTicks++;
    }

    const { mode, scoreLimit, endsAt } = this.state;
    const reachedLimit = scoreLimit > 0 && [...this.scores.values()].some((s) => scoreFor(mode, s) >= scoreLimit);
    const outOfTime = endsAt !== null && world.tick >= endsAt;
    if (reachedLimit || outOfTime) this.end(world.tick);
  }

  private scoreDeath(world: World, victimId: number, killerId: number | null): void {
    const victim = this.scores.get(victimId);
    if (!victim) {
      // Not a player but one of the city's people: only worth a few points.
      const kind = world.peds.get(victimId)?.kind;
      if (killerId !== null) this.addPoints(killerId, kind === 'gangster' ? POINTS.gangster : kind === 'cop' ? POINTS.cop : POINTS.pedestrian);
      return;
    }
    victim.deaths++;
    const killer = killerId === null ? undefined : this.scores.get(killerId);
    if (!killer || killerId === null) return; // accidents only count as a death
    const suicide = killerId === victimId;
    killer.frags += suicide ? -1 : 1;
    killer.points += suicide ? POINTS.suicide : POINTS.kill;
    // Tag: kill "it" and you're "it". Dying any other way, "it" stays "it".
    if (world.itPedId === victimId && !suicide) world.itPedId = killerId;
  }

  private addPoints(pedId: number, points: number): void {
    const score = this.scores.get(pedId);
    if (score) score.points += points;
  }

  private end(tick: number): void {
    const { mode } = this.state;
    const best = Math.max(...[...this.scores.values()].map((s) => scoreFor(mode, s)));
    this.state = {
      ...this.state,
      phase: 'intermission',
      restartAt: tick + this.settings.intermissionTicks,
      winnerIds: [...this.scores].filter(([, s]) => scoreFor(mode, s) === best).map(([id]) => id),
    };
  }

  /** Next mode, fresh scores, and every player back at a spawn point with full health and no weapons. */
  private startNewMatch(world: World): void {
    this.modeIndex = (this.modeIndex + 1) % this.settings.modes.length;
    for (const [pedId, score] of this.scores) {
      Object.assign(score, emptyScore());
      const ped = world.peds.get(pedId);
      if (!ped) continue;
      const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
      if (car?.driverId === pedId) car.driverId = null;
      Object.assign(ped, { weapon: null, ammo: {}, fireCooldown: 0 });
      respawnPed(world, ped);
    }
    this.state = this.newMatchState(world);
  }

  private newMatchState(world: World): MatchState {
    const mode = this.settings.modes[this.modeIndex] ?? 'frag';
    world.itPedId = mode === 'tag' ? this.randomPlayer(world) : null;
    const { timeLimitTicks } = this.settings;
    return {
      mode,
      phase: 'playing',
      scoreLimit: this.settings.scoreLimits[mode],
      endsAt: timeLimitTicks > 0 ? world.tick + timeLimitTicks : null,
      restartAt: null,
      winnerIds: [],
    };
  }

  private randomPlayer(world: World): number | null {
    const ids = [...this.scores.keys()].filter((id) => world.peds.has(id));
    return ids.length > 0 ? randomPick(world, ids) : null;
  }
}
