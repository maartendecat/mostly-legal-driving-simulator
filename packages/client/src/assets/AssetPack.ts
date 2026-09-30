import type { Object3D } from 'three';
import type { BlockMap, Car, GameEvent, Ped, Pickup, Projectile } from '@game/shared';

/** A renderable object for one game entity. The renderer positions and rotates `object` each frame. */
export interface EntityView {
  readonly object: Object3D;
  /** Per-frame animation hook (wheels, walk cycle, damage, ...). */
  update?(dt: number): void;
  dispose(): void;
}

/** A short-lived visual effect (spark, explosion). Positioned once by the renderer when spawned. */
export interface EffectView {
  readonly object: Object3D;
  /** Advances the animation; returns false once the effect has finished. */
  update(dt: number): boolean;
  dispose(): void;
}

/**
 * Everything that decides how the game looks and sounds. Game code only talks to this interface,
 * so packs are interchangeable:
 *  - PlaceholderPack: coloured boxes, no files needed (current default)
 *  - an open-licensed pack (e.g. Kenney CC0 art) for public servers
 *  - a "classic" pack converted in the browser from the player's own GTA2 .sty/.gmp files
 *
 * Gameplay data (car sizes, speeds, collision) is NOT part of a pack; it lives in @game/shared so
 * the server can simulate without any graphics. Entity views must match those dimensions:
 * cars are `length` long along local +x, `width` wide along local y, with z pointing up.
 */
export interface AssetPack {
  readonly id: string;
  readonly name: string;
  load(): Promise<void>;
  buildMap(map: BlockMap): Object3D;
  createCarView(car: Car): EntityView;
  createPedView(ped: Ped): EntityView;
  createProjectileView(projectile: Projectile): EntityView;
  createPickupView(pickup: Pickup): EntityView;
  /** The effect for a game event, or null if this pack shows nothing for it. */
  createEffectView(event: GameEvent): EffectView | null;
}
