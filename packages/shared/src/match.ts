import { isDead, respawnPed } from './damage';
import { randomPick } from './math';
import { secondsToTicks } from './time';
import { isLaw, type World } from './world';

/**
 * The multiplayer game modes, as in GTA2:
 *  - frag:   +1 per kill, −1 for killing yourself. Most frags wins.
 *  - points: kills are worth a big bonus, wrecking cars earns a little. Most points wins.
 *  - tag:    one player is "it". Whoever kills "it" becomes "it". Longest time as "it" wins.
 * And one of our own:
 *  - coop:   everyone together against the police, for as long as possible. Everyone is wanted
 *            from the start, and the pressure keeps rising (one star at first, the army after
 *            four minutes; see COOP_*). Players can't hurt each other. Each has three lives
 *            (dying or getting busted costs one); the match ends when everyone's out, and the
 *            score is how long the team held out (with the room's best).
 *
 * A match ends when someone reaches the score limit or time runs out. Then there's a short
 * intermission showing the scores, everyone respawns, and the next match starts.
 */

export type MatchMode = 'frag' | 'points' | 'tag' | 'coop';
export const MATCH_MODES: readonly MatchMode[] = ['frag', 'points', 'tag', 'coop'];
/** The modes players play against each other (what MODE=rotate goes through). */
export const VERSUS_MODES: readonly MatchMode[] = ['frag', 'points', 'tag'];

/** Co-op: lives per player... */
export const COOP_LIVES = 3;
/** ...and the police pressure: the heat everyone has at least, from one star at the start... */
const COOP_START_HEAT = 10;
/** ...rising to the army's (220) after four minutes. */
const COOP_HEAT_PER_TICK = (220 - COOP_START_HEAT) / secondsToTicks(4 * 60);
/** Out of lives: never coming back (until the next match). */
const OUT = Number.MAX_SAFE_INTEGER;

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
  scoreLimits: { frag: 10, points: 10_000, tag: secondsToTicks(120), coop: 0 },
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
  /** A cop, SWAT officer or soldier, but only while the killer has three stars or fewer. */
  cop: 50,
  /** Getting arrested by the police. */
  busted: -250,
} as const;

/** Where something happened (an event's position). */
type Spot = { x: number; y: number };

/** Above this many stars, killing the police earns nothing (see scoreDeath). */
const MAX_POINTS_WANTED_LEVEL = 3;

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
  /** The tick the match started. */
  startedAt: number;
  /** Co-op: how long the team held out (set when the match ends), and the room's best so far. */
  heldOut: number | null;
  bestHeldOut: number | null;
}

export interface PlayerScore {
  frags: number;
  deaths: number;
  points: number;
  /** Ticks spent alive as "it" (tag). */
  itTicks: number;
  /** Co-op: lives left (0: out, watching the others). */
  lives: number;
}

/** The number that decides who wins in `mode`. */
export function scoreFor(mode: MatchMode, score: PlayerScore): number {
  // (Co-op is won or lost together; who scored most points is the team's best player.)
  return mode === 'frag' ? score.frags : mode === 'points' || mode === 'coop' ? score.points : score.itTicks;
}

export function emptyScore(): PlayerScore {
  return { frags: 0, deaths: 0, points: 0, itTicks: 0, lives: COOP_LIVES };
}

export class Match {
  state: MatchState;
  /** Scores by ped id, for every player in the game. */
  readonly scores = new Map<number, PlayerScore>();
  private modeIndex = 0;
  /** Co-op: the room's best time, kept from match to match. */
  private bestHeldOut: number | null = null;

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
    // (A copy: scoring adds 'points' events, for the pop-ups.)
    for (const event of [...world.events]) {
      if (event.type === 'death') this.scoreDeath(world, event.pedId, event.killerId, event);
      else if (event.type === 'carDestroyed' && event.attackerId !== null) this.addPoints(world, event.attackerId, POINTS.carDestroyed, event);
      else if (event.type === 'busted') this.scoreBusted(world, event.pedId, event);
    }
    if (this.state.mode === 'coop') {
      this.updateCoop(world);
      if ((this.state.phase as MatchPhase) === 'intermission') return;
    }
    if (this.state.mode === 'tag' && world.itPedId !== null) {
      const it = world.peds.get(world.itPedId);
      const score = this.scores.get(world.itPedId);
      if (it && score && !isDead(it)) score.itTicks++;
    }

    const { mode, scoreLimit, endsAt } = this.state;
    const reachedLimit = scoreLimit > 0 && [...this.scores.values()].some((s) => scoreFor(mode, s) >= scoreLimit);
    const outOfTime = endsAt !== null && world.tick >= endsAt;
    if (reachedLimit || outOfTime) this.end(world, world.tick);
  }

  /**
   * Co-op: the police pressure rises; players who died or got busted lose a life, and are out when
   * they have none left; when everyone's out, it's over.
   */
  private updateCoop(world: World): void {
    world.heatFloor = COOP_START_HEAT + (world.tick - this.state.startedAt) * COOP_HEAT_PER_TICK;
    for (const event of world.events) {
      if (event.type !== 'death' && event.type !== 'busted') continue;
      const score = this.scores.get(event.pedId);
      const ped = world.peds.get(event.pedId);
      if (!score || !ped || score.lives === 0) continue;
      score.lives--;
      if (score.lives === 0) ped.respawnAt = OUT;
    }
    const players = [...this.scores.values()];
    if (players.length > 0 && players.every((s) => s.lives === 0)) this.end(world, world.tick);
  }

  private scoreDeath(world: World, victimId: number, killerId: number | null, at: Spot): void {
    const victim = this.scores.get(victimId);
    if (!victim) {
      // Not a player but one of the city's people: only worth a few points.
      const victimPed = world.peds.get(victimId);
      const killer = killerId === null ? undefined : world.peds.get(killerId);
      if (!victimPed || !killer) return;
      // The police are worth points only while they're not out in force (three stars or fewer), so
      // the SWAT and the army aren't a way to farm points.
      const law = isLaw(victimPed);
      if (law && killer.wanted > MAX_POINTS_WANTED_LEVEL) return;
      this.addPoints(world, killer.id, victimPed.kind === 'gangster' ? POINTS.gangster : law ? POINTS.cop : POINTS.pedestrian, at);
      return;
    }
    victim.deaths++;
    const killer = killerId === null ? undefined : this.scores.get(killerId);
    if (!killer || killerId === null) return; // accidents only count as a death
    const suicide = killerId === victimId;
    killer.frags += suicide ? -1 : 1;
    this.addPoints(world, killerId, suicide ? POINTS.suicide : POINTS.kill, at);
    // Tag: kill "it" and you're "it". Dying any other way, "it" stays "it".
    if (world.itPedId === victimId && !suicide) world.itPedId = killerId;
  }

  /** Busted: a death (nobody's frag), and in Points mode it costs points too. */
  private scoreBusted(world: World, pedId: number, at: Spot): void {
    const score = this.scores.get(pedId);
    if (!score) return;
    score.deaths++;
    if (this.state.mode === 'points') this.addPoints(world, pedId, POINTS.busted, at);
  }

  /** Points for a player, announced where they were earned (a 'points' event: the pop-ups, as in GTA2). */
  private addPoints(world: World, pedId: number, points: number, at: Spot): void {
    const score = this.scores.get(pedId);
    if (!score || points === 0) return;
    score.points += points;
    world.events.push({ type: 'points', tick: world.tick, ownerId: pedId, pedId, points, x: at.x, y: at.y });
  }

  private end(world: World, tick: number): void {
    const { mode } = this.state;
    const best = Math.max(...[...this.scores.values()].map((s) => scoreFor(mode, s)));
    let heldOut: number | null = null;
    if (mode === 'coop') {
      // Over: the police call it off (and the army goes home) during the intermission.
      heldOut = tick - this.state.startedAt;
      this.bestHeldOut = Math.max(this.bestHeldOut ?? 0, heldOut);
      world.heatFloor = 0;
      world.wanted = [];
      for (const ped of world.peds.values()) ped.wanted = 0;
    }
    this.state = {
      ...this.state,
      heldOut,
      bestHeldOut: this.bestHeldOut,
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
    // Co-op: players are on the same side, and the police are after all of them.
    world.friendlyFire = mode !== 'coop';
    world.heatFloor = mode === 'coop' ? COOP_START_HEAT : 0;
    const { timeLimitTicks } = this.settings;
    return {
      mode,
      phase: 'playing',
      scoreLimit: this.settings.scoreLimits[mode],
      endsAt: timeLimitTicks > 0 ? world.tick + timeLimitTicks : null,
      restartAt: null,
      winnerIds: [],
      startedAt: world.tick,
      heldOut: null,
      bestHeldOut: this.bestHeldOut,
    };
  }

  private randomPlayer(world: World): number | null {
    const ids = [...this.scores.keys()].filter((id) => world.peds.has(id));
    return ids.length > 0 ? randomPick(world, ids) : null;
  }
}
