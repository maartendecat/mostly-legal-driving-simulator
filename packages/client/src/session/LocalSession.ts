import { DEFAULT_MATCH_SETTINGS, Match, TICK_DT, emptyScore, createWorld, generateCity, spawnPed, stepWorld, type GameEvent, type PlayerInfo, type PlayerInput, type World, type WorldOptions } from '@game/shared';
import { captureTransforms, interpolateTransforms, type TransformSnapshot } from '../render/transforms';
import type { FrameState, GameSession } from './GameSession';

/** Offline, the city is as lively as on the server by default. */
const OFFLINE_CITY: WorldOptions = { traffic: 40, pedestrians: 100, gangMembers: 15, cops: 15, policeCars: 5, fireTrucks: 3, police: 'on' };

/** Single-player: runs the shared simulation in the browser at the fixed tick rate. */
export class LocalSession implements GameSession {
  readonly world: World;
  readonly myPedId: number;
  readonly players: readonly PlayerInfo[];
  readonly match = null;
  private previous: TransformSnapshot;
  private accumulator = 0;
  /** No match offline, but points are still counted, for the pop-ups: a Points match without limits. */
  private readonly scorer: Match;

  constructor(
    seed: number,
    readonly status = 'Offline',
  ) {
    this.world = createWorld(generateCity(seed), seed, OFFLINE_CITY);
    this.myPedId = spawnPed(this.world).id;
    this.players = [{ pedId: this.myPedId, name: 'You', ...emptyScore() }];
    this.previous = captureTransforms(this.world);
    this.scorer = new Match({ ...DEFAULT_MATCH_SETTINGS, modes: ['points'], scoreLimits: { ...DEFAULT_MATCH_SETTINGS.scoreLimits, points: 0 }, timeLimitTicks: 0 }, this.world);
    this.scorer.addPlayer(this.world, this.myPedId);
  }

  update(frameDt: number, sampleInput: () => PlayerInput): FrameState {
    this.accumulator += frameDt;
    const events: GameEvent[] = [];
    while (this.accumulator >= TICK_DT) {
      this.previous = captureTransforms(this.world);
      stepWorld(this.world, new Map([[this.myPedId, sampleInput()]]));
      this.scorer.update(this.world);
      events.push(...this.world.events);
      this.accumulator -= TICK_DT;
    }
    return { transforms: interpolateTransforms(this.previous, this.world, this.accumulator / TICK_DT), events };
  }
}
