import { lerp, lerpAngle, type World } from '@game/shared';

export interface Transform {
  x: number;
  y: number;
  heading: number;
}

/** Entity transforms keyed by entity id. */
export type TransformSnapshot = Map<number, Transform>;

export function captureTransforms(world: World): TransformSnapshot {
  const snapshot: TransformSnapshot = new Map();
  for (const car of world.cars.values()) snapshot.set(car.id, { x: car.x, y: car.y, heading: car.heading });
  for (const ped of world.peds.values()) snapshot.set(ped.id, { x: ped.x, y: ped.y, heading: ped.heading });
  for (const p of world.projectiles.values()) snapshot.set(p.id, { x: p.x, y: p.y, heading: p.heading });
  for (const h of world.helicopters.values()) snapshot.set(h.id, { x: h.x, y: h.y, heading: h.heading });
  return snapshot;
}

export function lerpTransform(from: Transform, to: Transform, alpha: number): Transform {
  return { x: lerp(from.x, to.x, alpha), y: lerp(from.y, to.y, alpha), heading: lerpAngle(from.heading, to.heading, alpha) };
}

/** Blends every entity from its `previous` transform towards its current one in `world`. */
export function interpolateTransforms(previous: TransformSnapshot, world: World, alpha: number): TransformSnapshot {
  const result: TransformSnapshot = new Map();
  for (const entity of [...world.cars.values(), ...world.peds.values(), ...world.projectiles.values(), ...world.helicopters.values()]) {
    result.set(entity.id, lerpTransform(previous.get(entity.id) ?? entity, entity, alpha));
  }
  return result;
}
