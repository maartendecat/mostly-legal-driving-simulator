import { TICK_DT, createWorld, generateCity, spawnPed, stepWorld, type GameEvent, type PlayerInfo, type PlayerInput, type World } from '@game/shared';
import { captureTransforms, interpolateTransforms, type TransformSnapshot } from '../render/transforms';
import type { FrameState, GameSession } from './GameSession';

/** Single-player: runs the shared simulation in the browser at the fixed tick rate. */
export class LocalSession implements GameSession {
  readonly world: World;
  readonly myPedId: number;
  readonly players: readonly PlayerInfo[];
  readonly match = null;
  private previous: TransformSnapshot;
  private accumulator = 0;

  constructor(
    seed: number,
    readonly status = 'Offline',
  ) {
    this.world = createWorld(generateCity(seed), seed);
    this.myPedId = spawnPed(this.world).id;
    this.players = [{ pedId: this.myPedId, name: 'You', frags: 0, deaths: 0, points: 0, itTicks: 0 }];
    this.previous = captureTransforms(this.world);
  }

  update(frameDt: number, sampleInput: () => PlayerInput): FrameState {
    this.accumulator += frameDt;
    const events: GameEvent[] = [];
    while (this.accumulator >= TICK_DT) {
      this.previous = captureTransforms(this.world);
      stepWorld(this.world, new Map([[this.myPedId, sampleInput()]]));
      events.push(...this.world.events);
      this.accumulator -= TICK_DT;
    }
    return { transforms: interpolateTransforms(this.previous, this.world, this.accumulator / TICK_DT), events };
  }
}
