import { randomPick } from './math';
import { provokeGang } from './gangs';
import { HELICOPTER_RADIUS, damageHelicopter } from './helicopter';
import { crewOf, reportCrime, reportHarm, reportWreck } from './police';
import { WRECK_BURN_TICKS } from './fire';
import { CORPSE_TICKS, ejectDriver } from './pedestrians';
import { secondsToTicks } from './time';
import { CAR_MODELS } from './vehicles';
import type { WeaponId } from './weapons';
import { spawnRandomCar, type Car, type Ped, type World } from './world';

/** What killed someone, for kill messages and scoring. */
export type DamageCause = WeaponId | 'runOver' | 'carExplosion';

export const PED_MAX_HEALTH = 100;
export const RESPAWN_TICKS = secondsToTicks(3);
/** How long a destroyed car burns before it explodes; enough time to jump out. */
export const CAR_BURN_TICKS = secondsToTicks(3);
/**
 * A car destroyed by a rocket goes up this soon after the rocket's blast: a separate "boom" right
 * after the first one feels much more powerful than one merged explosion.
 */
export const ROCKET_CAR_FUSE_TICKS = secondsToTicks(0.3);
/** How long a burnt-out wreck stays before it's replaced by a fresh car. */
export const WRECK_TICKS = secondsToTicks(30);
const CAR_EXPLOSION_RADIUS = 2.5;
const CAR_EXPLOSION_DAMAGE = 150;
/** Tag: a car driven by "it" takes this much more damage, so it catches fire quickly. */
const IT_CAR_DAMAGE = 2;
/** A traffic driver only gets out of a burning car if it takes at least this long to blow. */
const MIN_BAIL_OUT_TICKS = secondsToTicks(1);
/** A new car only appears at a spawn point with nothing this close to it. */
const CAR_RESPAWN_CLEARANCE = 2.5;

export function isDead(ped: Ped): boolean {
  return ped.respawnAt !== null;
}

/**
 * Hurts a ped. At zero health they're "wasted": out of any car, weapons dropped, and back after
 * RESPAWN_TICKS. `attackerId` is whoever gets the credit (null for accidents).
 */
export function damagePed(world: World, ped: Ped, amount: number, attackerId: number | null, cause: DamageCause): void {
  if (isDead(ped) || amount <= 0) return;
  // Co-op: players can't hurt each other (only themselves, with their own rockets).
  if (!world.friendlyFire && ped.kind === 'player' && attackerId !== null && attackerId !== ped.id && world.peds.get(attackerId)?.kind === 'player') return;
  if (ped.kind === 'gangster') provokeGang(world, ped, attackerId);
  ped.health -= amount;
  if (ped.health > 0) {
    reportHarm(world, ped, attackerId, cause, false);
    return;
  }

  ped.health = 0;
  // Players come back; a pedestrian's body is cleared away after a while.
  ped.respawnAt = world.tick + (ped.kind !== 'player' ? CORPSE_TICKS : RESPAWN_TICKS);
  const car = ped.carId === null ? undefined : world.cars.get(ped.carId);
  if (car && car.driverId === ped.id) car.driverId = null;
  ped.carId = null;
  ped.weapon = null;
  ped.ammo = {};
  ped.fireCooldown = 0;
  world.events.push({
    type: 'death',
    tick: world.tick,
    ownerId: attackerId ?? ped.id,
    pedId: ped.id,
    killerId: attackerId,
    cause,
    x: ped.x,
    y: ped.y,
  });
  reportHarm(world, ped, attackerId, cause, true);
}

/**
 * Hurts a car. At zero health it catches fire and explodes `fuseTicks` later. More damage to a
 * burning car can only make it blow sooner, never later.
 */
export function damageCar(world: World, car: Car, amount: number, attackerId: number | null, fuseTicks = CAR_BURN_TICKS): void {
  if (car.wrecked || amount <= 0) return;
  if (car.driverId !== null && car.driverId === world.itPedId) amount *= IT_CAR_DAMAGE;
  // Accidents don't clear the credit: shoot a car, then its driver crashes it, and it's still yours.
  if (attackerId !== null) car.lastAttackerId = attackerId;
  if (car.police) reportCrime(world, attackerId, 'assaultPolice');
  car.health = Math.max(0, car.health - amount);
  if (car.health > 0) return;
  // A traffic car's driver bails out of the burning car and runs (no time for that when a rocket
  // blows it up); the car rolls to a stop. A police car's crew both get out.
  if (car.traffic && car.explodeAt === null && fuseTicks >= MIN_BAIL_OUT_TICKS) {
    ejectDriver(world, car, car, car.police ? crewOf(car) : 'civilian', 1);
    if (car.police) ejectDriver(world, car, car, crewOf(car), -1);
  }
  car.traffic = null;
  car.siren = false;
  const explodeAt = world.tick + fuseTicks;
  car.explodeAt = car.explodeAt === null ? explodeAt : Math.min(car.explodeAt, explodeAt);
}

/**
 * Damages everything within `radius`, less the further from the centre. Peds inside cars are
 * shielded by the car (which takes the hit instead).
 *
 * Cars destroyed by a weapon's blast (rockets) blow up a moment later. Cars destroyed by another car
 * exploding burn first, so chain reactions go off one after another rather than all at once.
 */
export function explode(
  world: World,
  x: number,
  y: number,
  radius: number,
  damage: number,
  attackerId: number | null,
  cause: DamageCause,
  ignoreCarId: number | null = null,
): void {
  world.events.push({ type: 'explosion', tick: world.tick, ownerId: attackerId ?? -1, x, y, radius });
  for (const ped of world.peds.values()) {
    if (ped.carId !== null) continue;
    const d = Math.hypot(ped.x - x, ped.y - y);
    if (d < radius) damagePed(world, ped, damage * (1 - d / radius), attackerId, cause);
  }
  for (const car of world.cars.values()) {
    if (car.id === ignoreCarId) continue;
    const d = Math.hypot(car.x - x, car.y - y);
    const fuse = cause === 'carExplosion' ? CAR_BURN_TICKS : ROCKET_CAR_FUSE_TICKS;
    if (d < radius) damageCar(world, car, damage * (1 - d / radius), attackerId, fuse);
  }
  for (const heli of world.helicopters.values()) {
    const d = Math.hypot(heli.x - x, heli.y - y);
    if (d < radius + HELICOPTER_RADIUS) damageHelicopter(world, heli, damage * Math.min(1, 1 - (d - HELICOPTER_RADIUS) / radius), attackerId);
  }
}

/** Respawns dead peds, blows up burning cars and replaces old wrecks. Runs once per tick. */
export function updateLifecycle(world: World): void {
  for (const ped of [...world.peds.values()]) {
    if (ped.respawnAt === null || world.tick < ped.respawnAt) continue;
    if (ped.kind !== 'player') world.peds.delete(ped.id);
    else respawnPed(world, ped);
  }
  for (const car of [...world.cars.values()]) {
    if (!car.wrecked && car.explodeAt !== null && world.tick >= car.explodeAt) explodeCar(world, car);
    else if (car.wrecked && car.burnsUntil !== null && world.tick >= car.burnsUntil) car.burnsUntil = null; // burnt out
    // (A wreck still on fire stays until the fire's out.)
    else if (car.wrecked && car.burnsUntil === null && car.removeAt !== null && world.tick >= car.removeAt) replaceWreck(world, car);
  }
}

/** Puts a ped back at a random spawn point with full health. */
export function respawnPed(world: World, ped: Ped): void {
  const spawn = world.map.pedSpawns.length > 0 ? randomPick(world, world.map.pedSpawns) : { x: world.map.width / 2, y: world.map.height / 2 };
  Object.assign(ped, { x: spawn.x, y: spawn.y, health: PED_MAX_HEALTH, respawnAt: null, carId: null });
}

function explodeCar(world: World, car: Car): void {
  car.wrecked = true;
  car.explodeAt = null;
  car.removeAt = world.tick + WRECK_TICKS;
  car.burnsUntil = world.tick + WRECK_BURN_TICKS;
  car.vx *= 0.3;
  car.vy *= 0.3;
  world.events.push({
    type: 'carDestroyed',
    tick: world.tick,
    ownerId: car.lastAttackerId ?? -1,
    carId: car.id,
    attackerId: car.lastAttackerId,
    x: car.x,
    y: car.y,
  });
  reportWreck(world, car);
  const driver = car.driverId === null ? undefined : world.peds.get(car.driverId);
  if (driver) damagePed(world, driver, PED_MAX_HEALTH, car.lastAttackerId, 'carExplosion');
  explode(world, car.x, car.y, CAR_EXPLOSION_RADIUS, CAR_EXPLOSION_DAMAGE, car.lastAttackerId, 'carExplosion', car.id);
}

/** Removes a wreck and puts a fresh car at a free spawn point somewhere in the city. */
function replaceWreck(world: World, wreck: Car): void {
  world.cars.delete(wreck.id);
  const free = world.map.carSpawns.filter((spawn) => {
    const clear = (e: { x: number; y: number }) => Math.hypot(e.x - spawn.x, e.y - spawn.y) > CAR_RESPAWN_CLEARANCE;
    return [...world.cars.values()].every(clear) && [...world.peds.values()].every(clear);
  });
  if (free.length > 0) spawnRandomCar(world, randomPick(world, free));
}

/** Max health for a fresh car of this model. */
export function carMaxHealth(car: Car): number {
  return CAR_MODELS[car.model].health;
}
