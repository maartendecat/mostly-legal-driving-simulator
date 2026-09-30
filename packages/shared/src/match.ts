import { respawnPed } from './damage';
import { secondsToTicks } from './time';
import type { World } from './world';

/**
 * Frag mode, as in GTA2 multiplayer: kill other players for points. First to the frag limit wins,
 * or whoever leads when time runs out. Between matches there's a short intermission showing the
 * scores, then everyone respawns and a new match starts.
 */

export type MatchPhase = 'playing' | 'intermission';

export interface MatchSettings {
  /** First to this many frags wins; 0 for no limit. */
  fragLimit: number;
  /** Match length in ticks; 0 for no limit. */
  timeLimitTicks: number;
  /** Pause between matches, showing the final scores. */
  intermissionTicks: number;
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  fragLimit: 10,
  timeLimitTicks: secondsToTicks(10 * 60),
  intermissionTicks: secondsToTicks(10),
};

/** What clients need to know about the match; sent in every snapshot. */
export interface MatchState {
  mode: 'frag';
  phase: MatchPhase;
  fragLimit: number;
  /** Tick at which the match ends on time, or null without a time limit. */
  endsAt: number | null;
  /** During intermission: the tick at which the next match starts. */
  restartAt: number | null;
  /** The players with the most frags when the match ended (more than one on a tie). */
  winnerIds: number[];
}

export interface PlayerScore {
  frags: number;
  deaths: number;
}

export class FragMatch {
  state: MatchState;
  /** Scores by ped id, for every player in the game. */
  readonly scores = new Map<number, PlayerScore>();

  constructor(
    private readonly settings: MatchSettings,
    tick: number,
  ) {
    this.state = this.newMatchState(tick);
  }

  addPlayer(pedId: number): void {
    if (!this.scores.has(pedId)) this.scores.set(pedId, { frags: 0, deaths: 0 });
  }

  removePlayer(pedId: number): void {
    this.scores.delete(pedId);
  }

  /** Scores this tick's deaths and moves the match along. Call after every world step. */
  update(world: World): void {
    if (this.state.phase === 'intermission') {
      if (world.tick >= this.state.restartAt!) this.startNewMatch(world);
      return;
    }
    for (const event of world.events) {
      if (event.type === 'death') this.scoreDeath(event.pedId, event.killerId);
    }
    const { fragLimit, endsAt } = this.state;
    const reachedFragLimit = fragLimit > 0 && [...this.scores.values()].some((s) => s.frags >= fragLimit);
    const outOfTime = endsAt !== null && world.tick >= endsAt;
    if (reachedFragLimit || outOfTime) this.end(world.tick);
  }

  /** Kills score +1; killing yourself costs one; accidents (no killer) only count as a death. */
  private scoreDeath(victimId: number, killerId: number | null): void {
    const victim = this.scores.get(victimId);
    if (victim) victim.deaths++;
    const killer = killerId === null ? undefined : this.scores.get(killerId);
    if (killer) killer.frags += killerId === victimId ? -1 : 1;
  }

  private end(tick: number): void {
    const best = Math.max(...[...this.scores.values()].map((s) => s.frags));
    this.state = {
      ...this.state,
      phase: 'intermission',
      restartAt: tick + this.settings.intermissionTicks,
      winnerIds: [...this.scores].filter(([, s]) => s.frags === best).map(([id]) => id),
    };
  }

  /** Fresh scores, and every player back at a spawn point with full health and no weapons. */
  private startNewMatch(world: World): void {
    for (const [pedId, score] of this.scores) {
      score.frags = 0;
      score.deaths = 0;
      const ped = world.peds.get(pedId);
      if (!ped) continue;
      const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
      if (car?.driverId === pedId) car.driverId = null;
      Object.assign(ped, { weapon: null, ammo: {}, fireCooldown: 0 });
      respawnPed(world, ped);
    }
    this.state = this.newMatchState(world.tick);
  }

  private newMatchState(tick: number): MatchState {
    const { fragLimit, timeLimitTicks } = this.settings;
    return {
      mode: 'frag',
      phase: 'playing',
      fragLimit,
      endsAt: timeLimitTicks > 0 ? tick + timeLimitTicks : null,
      restartAt: null,
      winnerIds: [],
    };
  }
}
