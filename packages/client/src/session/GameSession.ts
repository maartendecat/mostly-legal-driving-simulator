import type { PlayerInput, World } from '@game/shared';
import type { TransformSnapshot } from '../render/GameRenderer';

export interface FrameState {
  /** Entity transforms to interpolate from. */
  previous: TransformSnapshot;
  /** Interpolation factor between `previous` and the current world, in [0, 1]. */
  alpha: number;
}

/** Where the world comes from: simulated locally, or received from a server. */
export interface GameSession {
  readonly world: World;
  /** The ped this client controls, or null until the server has assigned one. */
  readonly myPedId: number | null;
  /** Short status for the HUD, e.g. "Offline" or "Online · 3 players · 40 ms". */
  readonly status: string;
  /** Advances the session by one rendered frame. `sampleInput` is called once per simulation tick. */
  update(frameDt: number, sampleInput: () => PlayerInput): FrameState;
}
