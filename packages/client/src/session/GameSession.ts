import type { PlayerInput, World } from '@game/shared';
import type { TransformSnapshot } from '../render/GameRenderer';

export interface FrameState {
  /** Where to draw each entity this frame. */
  transforms: TransformSnapshot;
}

/** Where the world comes from: simulated locally, or received from a server. */
export interface GameSession {
  /** The world as it should be drawn this frame. */
  readonly world: World;
  /** The ped this client controls, or null until the server has assigned one. */
  readonly myPedId: number | null;
  /** Short status for the HUD, e.g. "Offline" or "Online · 3 players · 40 ms". */
  readonly status: string;
  /** Advances the session by one rendered frame. `sampleInput` is called once per simulation tick. */
  update(frameDt: number, sampleInput: () => PlayerInput): FrameState;
}
