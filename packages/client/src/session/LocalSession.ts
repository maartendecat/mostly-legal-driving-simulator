import { TICK_DT, createWorld, generateCity, spawnPed, stepWorld, type PlayerInput, type World } from '@game/shared';
import { captureTransforms, interpolateTransforms, type TransformSnapshot } from '../render/GameRenderer';
import type { FrameState, GameSession } from './GameSession';

/** Single-player: runs the shared simulation in the browser at the fixed tick rate. */
export class LocalSession implements GameSession {
  readonly world: World;
  readonly myPedId: number;
  private previous: TransformSnapshot;
  private accumulator = 0;

  constructor(
    seed: number,
    readonly status = 'Offline',
  ) {
    this.world = createWorld(generateCity(seed), seed);
    this.myPedId = spawnPed(this.world).id;
    this.previous = captureTransforms(this.world);
  }

  update(frameDt: number, sampleInput: () => PlayerInput): FrameState {
    this.accumulator += frameDt;
    while (this.accumulator >= TICK_DT) {
      this.previous = captureTransforms(this.world);
      stepWorld(this.world, new Map([[this.myPedId, sampleInput()]]));
      this.accumulator -= TICK_DT;
    }
    return { transforms: interpolateTransforms(this.previous, this.world, this.accumulator / TICK_DT) };
  }
}
