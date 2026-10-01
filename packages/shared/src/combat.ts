import { damageCar, damagePed, explode, isDead, type DamageCause } from './damage';
import type { PlayerInput } from './input';
import { isSolidAt } from './map';
import { secondsToTicks } from './time';
import { WEAPONS, WEAPON_IDS, type ProjectileKind, type WeaponId } from './weapons';
import { PED_RADIUS, carContainsPoint, type Car, type Ped, type World } from './world';

/** A bullet or rocket in flight. */
export interface Projectile {
  id: number;
  kind: ProjectileKind;
  weapon: WeaponId;
  ownerId: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  ticksLeft: number;
}

/** A weapon lying on the ground. It's taken when a ped on foot walks over it, then respawns. */
export interface Pickup {
  id: number;
  weapon: WeaponId;
  x: number;
  y: number;
  /** Tick from which the pickup can be taken; it's hidden before that. */
  availableAt: number;
}

/**
 * Things that happened during a tick that clients show as effects (sparks, explosions, sounds).
 * They don't change the world state themselves.
 */
export type GameEvent =
  | { type: 'impact'; tick: number; ownerId: number; x: number; y: number }
  | { type: 'explosion'; tick: number; ownerId: number; x: number; y: number; radius: number }
  /** `killerId` is null for accidents; `ownerId` is the killer, or the victim if there is none. */
  | { type: 'death'; tick: number; ownerId: number; pedId: number; killerId: number | null; cause: DamageCause; x: number; y: number }
  /** A gang is now after a player (`pedId`), who hurt one of its members (at x, y). */
  | { type: 'gangAngry'; tick: number; ownerId: number; gang: number; pedId: number; x: number; y: number }
  /** A car blew up; `attackerId` is who gets the credit (null for accidents). */
  | { type: 'carDestroyed'; tick: number; ownerId: number; carId: number; attackerId: number | null; x: number; y: number };

export const PICKUP_RADIUS = 0.45;
const PICKUP_RESPAWN_TICKS = secondsToTicks(10);
/** Where a shot starts, measured from the ped's edge along its heading. */
const MUZZLE_GAP = 0.15;
/** Projectiles move in a few small steps per tick so fast bullets can't skip past thin things. */
const PROJECTILE_SUBSTEPS = 3;
/** Cars are tougher than people: bullets do this fraction of their damage to them. */
const BULLET_CAR_DAMAGE = 0.5;

type Hit = { type: 'wall' } | { type: 'car'; car: Car } | { type: 'ped'; ped: Ped };

export function isPickupAvailable(world: World, pickup: Pickup): boolean {
  return world.tick >= pickup.availableAt;
}

export function spawnPickup(world: World, weapon: WeaponId, x: number, y: number): Pickup {
  const pickup: Pickup = { id: world.nextId++, weapon, x, y, availableAt: 0 };
  world.pickups.set(pickup.id, pickup);
  return pickup;
}

/** Weapon switching and firing for one ped, for one tick. `switchDirection` is +1, -1 or 0. */
export function updateWeapons(world: World, ped: Ped, input: PlayerInput, switchDirection: number): void {
  if (ped.fireCooldown > 0) ped.fireCooldown--;
  if (switchDirection !== 0) cycleWeapon(ped, switchDirection);
  // No drive-bys yet: you can only shoot on foot. (Dead peds never get here.)
  if (input.fire && ped.carId === null) fireWeapon(world, ped);
}

/** Selects the next (or previous) weapon that has ammo; unarmed if there is none. */
export function cycleWeapon(ped: Ped, direction: number): void {
  const owned = WEAPON_IDS.filter((id) => (ped.ammo[id] ?? 0) > 0);
  if (owned.length === 0) {
    ped.weapon = null;
    return;
  }
  const current = ped.weapon === null ? -1 : owned.indexOf(ped.weapon);
  const start = current === -1 && direction < 0 ? 0 : current;
  ped.weapon = owned[(start + direction + owned.length) % owned.length]!;
}

/** Fires the weapon in hand along the ped's heading, if it's ready and loaded. */
export function fireWeapon(world: World, ped: Ped): void {
  if (ped.weapon === null || ped.fireCooldown > 0) return;
  const ammo = ped.ammo[ped.weapon] ?? 0;
  if (ammo <= 0) return;

  const weapon = WEAPONS[ped.weapon];
  const muzzle = PED_RADIUS + MUZZLE_GAP;
  // Deterministic "random" spread, so the server and the predicting client agree on every shot.
  const heading = ped.heading + (hash01(world.tick, ped.id) * 2 - 1) * weapon.spread;
  const projectile: Projectile = {
    id: world.nextId++,
    kind: weapon.projectile,
    weapon: ped.weapon,
    ownerId: ped.id,
    x: ped.x + Math.cos(ped.heading) * muzzle,
    y: ped.y + Math.sin(ped.heading) * muzzle,
    heading,
    speed: weapon.speed,
    ticksLeft: secondsToTicks(weapon.range / weapon.speed),
  };
  world.projectiles.set(projectile.id, projectile);

  ped.fireCooldown = weapon.cooldownTicks;
  ped.ammo[ped.weapon] = ammo - 1;
  if (ammo - 1 === 0) cycleWeapon(ped, 1);
}

export function stepProjectiles(world: World, dt: number): void {
  for (const projectile of world.projectiles.values()) {
    const step = (projectile.speed * dt) / PROJECTILE_SUBSTEPS;
    const dx = Math.cos(projectile.heading) * step;
    const dy = Math.sin(projectile.heading) * step;
    let hit: Hit | null = null;
    for (let i = 0; i < PROJECTILE_SUBSTEPS && !hit; i++) {
      projectile.x += dx;
      projectile.y += dy;
      hit = findHit(world, projectile);
    }
    projectile.ticksLeft--;
    // Rockets explode when they run out of range too; bullets just drop.
    if (hit || (projectile.ticksLeft <= 0 && projectile.kind === 'rocket')) detonate(world, projectile, hit);
    else if (projectile.ticksLeft <= 0) world.projectiles.delete(projectile.id);
  }
}

function findHit(world: World, projectile: Projectile): Hit | null {
  const { x, y } = projectile;
  if (isSolidAt(world.map, x, y)) return { type: 'wall' };
  for (const car of world.cars.values()) {
    if (carContainsPoint(car, x, y)) return { type: 'car', car };
  }
  for (const ped of world.peds.values()) {
    if (ped.id === projectile.ownerId || ped.carId !== null || isDead(ped)) continue;
    if (Math.hypot(ped.x - x, ped.y - y) < PED_RADIUS) return { type: 'ped', ped };
  }
  return null;
}

function detonate(world: World, projectile: Projectile, hit: Hit | null): void {
  world.projectiles.delete(projectile.id);
  const weapon = WEAPONS[projectile.weapon];
  const { ownerId, x, y } = projectile;
  if (weapon.blastRadius > 0) {
    explode(world, x, y, weapon.blastRadius, weapon.damage, ownerId, projectile.weapon);
    return;
  }
  world.events.push({ type: 'impact', tick: world.tick, ownerId, x, y });
  if (hit?.type === 'ped') damagePed(world, hit.ped, weapon.damage, ownerId, projectile.weapon);
  else if (hit?.type === 'car') damageCar(world, hit.car, weapon.damage * BULLET_CAR_DAMAGE, ownerId);
}

/** Whether this ped is allowed to take weapons from pickups at all. Tag: "it" can't. */
export function canPickUpWeapons(world: World, ped: Ped): boolean {
  return ped.kind === 'player' && ped.id !== world.itPedId;
}

export function collectPickups(world: World): void {
  for (const pickup of world.pickups.values()) {
    if (!isPickupAvailable(world, pickup)) continue;
    const weapon = WEAPONS[pickup.weapon];
    for (const ped of world.peds.values()) {
      if (ped.carId !== null || isDead(ped) || Math.hypot(ped.x - pickup.x, ped.y - pickup.y) > PICKUP_RADIUS) continue;
      if (!canPickUpWeapons(world, ped)) continue;
      const ammo = ped.ammo[pickup.weapon] ?? 0;
      if (ammo >= weapon.maxAmmo) continue;
      ped.ammo[pickup.weapon] = Math.min(ammo + weapon.pickupAmmo, weapon.maxAmmo);
      if (ped.weapon === null) ped.weapon = pickup.weapon;
      pickup.availableAt = world.tick + PICKUP_RESPAWN_TICKS;
      break;
    }
  }
}

/** A well-mixed hash of two integers, in [0, 1). */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
